package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"time"
	"unicode"
)

type manifest struct {
	ProtocolVersion     string   `json:"protocol_version"`
	State               string   `json:"state"`
	SelectedModels      []string `json:"selected_models"`
	DeviceKeyID         string   `json:"device_key_id,omitempty"`
	DevicePublicKeySPKI string   `json:"device_public_key_spki,omitempty"`
}

func loopbackAgentAddress(raw string) (string, error) {
	host, port, err := net.SplitHostPort(raw)
	if err != nil || (host != "127.0.0.1" && host != "::1") || port != "1460" {
		return "", errors.New("provider agent listen address must use literal loopback port 1460")
	}
	return net.JoinHostPort(host, port), nil
}

func loopbackCoreURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("core URL must be credential-free loopback HTTP")
	}
	host := parsed.Hostname()
	if host != "127.0.0.1" && host != "::1" {
		return nil, errors.New("core URL must use literal loopback")
	}
	if parsed.Port() != "1455" {
		return nil, errors.New("core URL must use the packaged Core port")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	return parsed, nil
}

func selectedModels() ([]string, error) {
	raw := strings.TrimSpace(os.Getenv("MULTIVIBE_PROVIDER_SELECTED_MODELS"))
	if raw == "" {
		return []string{}, nil
	}
	var models []string
	if err := json.Unmarshal([]byte(raw), &models); err != nil {
		return nil, errors.New("selected model allowlist is invalid")
	}
	return normalizeSelectedModels(models)
}

var modelURLScheme = regexp.MustCompile(`[A-Za-z][A-Za-z0-9+.-]*:/`)
var windowsAbsolutePath = regexp.MustCompile(`^[A-Za-z]:/`)

func validSelectedModelID(model string) bool {
	if model == "" || len(model) > 200 || strings.TrimSpace(model) != model || strings.Contains(model, "\\") ||
		modelURLScheme.MatchString(model) || strings.HasPrefix(model, "/") || windowsAbsolutePath.MatchString(model) {
		return false
	}
	for _, value := range model {
		if unicode.IsControl(value) {
			return false
		}
	}
	for _, segment := range strings.Split(model, "/") {
		if segment == "." || segment == ".." || net.ParseIP(segment) != nil {
			return false
		}
		if strings.HasPrefix(segment, "[") && strings.HasSuffix(segment, "]") && net.ParseIP(strings.TrimSuffix(strings.TrimPrefix(segment, "["), "]")) != nil {
			return false
		}
	}
	return true
}

func selectedManifestState(models []string) LifecycleState {
	if len(models) == 0 {
		return StateDetected
	}
	return StateSelected
}

func providerHandler(core *url.URL, models []string, client *http.Client) http.Handler {
	return providerHandlerWithStores(core, newMemorySelectionStore(models), newMemoryRuntimeEndpointStore(), client, "")
}

func providerHandlerWithSelection(core *url.URL, selections *selectionStore, client *http.Client, controlToken string) http.Handler {
	return providerHandlerWithStores(core, selections, newMemoryRuntimeEndpointStore(), client, controlToken)
}

func providerHandlerWithStores(core *url.URL, selections *selectionStore, runtimes *runtimeEndpointStore, client *http.Client, controlToken string) http.Handler {
	return providerHandlerWithStoresAndIdentity(core, selections, runtimes, nil, client, controlToken)
}

func providerHandlerWithStoresAndIdentity(core *url.URL, selections *selectionStore, runtimes *runtimeEndpointStore, identity *deviceIdentity, client *http.Client, controlToken string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("content-type", "application/json")
		_, _ = response.Write([]byte("{\"ok\":true}\n"))
	})
	mux.HandleFunc("GET /health/ready", func(response http.ResponseWriter, request *http.Request) {
		probe, probeErr := http.NewRequestWithContext(request.Context(), http.MethodGet, core.String()+"/health", nil)
		if probeErr != nil {
			http.Error(response, "not ready", http.StatusServiceUnavailable)
			return
		}
		upstream, probeErr := client.Do(probe)
		if probeErr != nil || upstream.StatusCode != http.StatusOK {
			if upstream != nil {
				_ = upstream.Body.Close()
			}
			http.Error(response, "not ready", http.StatusServiceUnavailable)
			return
		}
		_ = upstream.Body.Close()
		response.Header().Set("content-type", "application/json")
		_, _ = response.Write([]byte("{\"ok\":true}\n"))
	})
	mux.HandleFunc("GET /v1/manifest", func(response http.ResponseWriter, _ *http.Request) {
		document := selections.snapshot()
		keyID := ""
		publicKeySPKI := ""
		if identity != nil {
			keyID, publicKeySPKI = identity.publicIdentity()
		}
		response.Header().Set("cache-control", "no-store")
		response.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(response).Encode(manifest{
			ProtocolVersion: "provider-agent-v1", State: document.State, SelectedModels: document.SelectedModels,
			DeviceKeyID: keyID, DevicePublicKeySPKI: publicKeySPKI,
		})
	})
	mux.HandleFunc("GET /v1/selection", func(response http.ResponseWriter, request *http.Request) {
		if !authorizeProviderControl(request, controlToken) {
			http.Error(response, "not found", http.StatusNotFound)
			return
		}
		response.Header().Set("cache-control", "no-store")
		response.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(response).Encode(selections.snapshot())
	})
	mux.HandleFunc("PUT /v1/selection", func(response http.ResponseWriter, request *http.Request) {
		if !authorizeProviderControl(request, controlToken) {
			http.Error(response, "not found", http.StatusNotFound)
			return
		}
		mediaType, _, mediaTypeErr := mime.ParseMediaType(request.Header.Get("content-type"))
		if mediaTypeErr != nil || mediaType != "application/json" {
			http.Error(response, "invalid request", http.StatusUnsupportedMediaType)
			return
		}
		request.Body = http.MaxBytesReader(response, request.Body, 32*1024)
		var update struct {
			Revision       uint64   `json:"revision"`
			SelectedModels []string `json:"selected_models"`
		}
		decoder := json.NewDecoder(request.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&update); err != nil || ensureJSONEOF(decoder) != nil || update.Revision < 1 {
			http.Error(response, "invalid request", http.StatusBadRequest)
			return
		}
		document, conflict, err := selections.replace(update.Revision, update.SelectedModels)
		if err != nil {
			if errors.Is(err, errInvalidSelectedModels) {
				http.Error(response, "invalid request", http.StatusBadRequest)
				return
			}
			http.Error(response, "selection unavailable", http.StatusInternalServerError)
			return
		}
		response.Header().Set("cache-control", "no-store")
		response.Header().Set("content-type", "application/json")
		if conflict {
			response.WriteHeader(http.StatusConflict)
		}
		_ = json.NewEncoder(response).Encode(document)
	})
	mux.HandleFunc("GET /v1/adapters", func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("cache-control", "no-store")
		response.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(response).Encode(runtimeAdapterRegistry())
	})
	mux.HandleFunc("GET /v1/runtime-endpoints", func(response http.ResponseWriter, request *http.Request) {
		if !authorizeProviderControl(request, controlToken) {
			http.Error(response, "not found", http.StatusNotFound)
			return
		}
		response.Header().Set("cache-control", "no-store")
		response.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(response).Encode(runtimes.snapshot())
	})
	mux.HandleFunc("PUT /v1/runtime-endpoints", func(response http.ResponseWriter, request *http.Request) {
		if !authorizeProviderControl(request, controlToken) {
			http.Error(response, "not found", http.StatusNotFound)
			return
		}
		mediaType, _, mediaTypeErr := mime.ParseMediaType(request.Header.Get("content-type"))
		if mediaTypeErr != nil || mediaType != "application/json" {
			http.Error(response, "invalid request", http.StatusUnsupportedMediaType)
			return
		}
		request.Body = http.MaxBytesReader(response, request.Body, 32*1024)
		var update struct {
			Revision  uint64                 `json:"revision"`
			Endpoints []runtimeEndpointInput `json:"endpoints"`
		}
		decoder := json.NewDecoder(request.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&update); err != nil || ensureJSONEOF(decoder) != nil || update.Revision < 1 {
			http.Error(response, "invalid request", http.StatusBadRequest)
			return
		}
		document, conflict, err := runtimes.replaceInputs(update.Revision, update.Endpoints, runtimeAdapterRegistry())
		if err != nil {
			if errors.Is(err, errInvalidRuntimeEndpoints) {
				http.Error(response, "invalid request", http.StatusBadRequest)
				return
			}
			http.Error(response, "runtime endpoints unavailable", http.StatusInternalServerError)
			return
		}
		response.Header().Set("cache-control", "no-store")
		response.Header().Set("content-type", "application/json")
		if conflict {
			response.WriteHeader(http.StatusConflict)
		}
		_ = json.NewEncoder(response).Encode(document)
	})
	mux.HandleFunc("GET /v1/detected-models", func(response http.ResponseWriter, request *http.Request) {
		if !authorizeProviderControl(request, controlToken) {
			http.Error(response, "not found", http.StatusNotFound)
			return
		}
		response.Header().Set("cache-control", "no-store")
		response.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(response).Encode(detectedModels(request.Context(), runtimeAdapterRegistry(), runtimes.configured(), client))
	})
	mux.HandleFunc("POST /v1/relay-shadow/session-open", func(response http.ResponseWriter, request *http.Request) {
		if !authorizeProviderControl(request, controlToken) {
			http.Error(response, "not found", http.StatusNotFound)
			return
		}
		if identity == nil {
			http.Error(response, "provider relay shadow identity unavailable", http.StatusServiceUnavailable)
			return
		}
		mediaType, _, mediaTypeErr := mime.ParseMediaType(request.Header.Get("content-type"))
		if mediaTypeErr != nil || mediaType != "application/json" {
			http.Error(response, "invalid request", http.StatusUnsupportedMediaType)
			return
		}
		request.Body = http.MaxBytesReader(response, request.Body, maxRelayEnvelopeBytes)
		var session relaySessionRequest
		decoder := json.NewDecoder(request.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&session); err != nil || ensureJSONEOF(decoder) != nil {
			http.Error(response, "invalid request", http.StatusBadRequest)
			return
		}
		envelope, err := identity.signRelaySession(session, time.Now())
		if err != nil {
			http.Error(response, "invalid request", http.StatusBadRequest)
			return
		}
		response.Header().Set("cache-control", "no-store")
		response.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(response).Encode(envelope)
	})
	return mux
}

func authorizeProviderControl(request *http.Request, expected string) bool {
	if len(expected) < 32 {
		return false
	}
	provided := strings.TrimPrefix(request.Header.Get("authorization"), "Bearer ")
	return len(provided) == len(expected) && subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	core, err := loopbackCoreURL(envDefault("MULTIVIBE_CORE_LOOPBACK_URL", "http://127.0.0.1:1455"))
	if err != nil {
		logger.Error("provider_agent_configuration_invalid", "error", err.Error())
		os.Exit(2)
	}
	models, err := selectedModels()
	if err != nil {
		logger.Error("provider_agent_configuration_invalid", "error", err.Error())
		os.Exit(2)
	}
	statePath := strings.TrimSpace(os.Getenv("MULTIVIBE_PROVIDER_STATE_PATH"))
	selections := newMemorySelectionStore(models)
	if statePath != "" {
		selections, err = openSelectionStore(statePath, models)
		if err != nil {
			logger.Error("provider_agent_configuration_invalid", "error", err.Error())
			os.Exit(2)
		}
	}
	runtimeStatePath := strings.TrimSpace(os.Getenv("MULTIVIBE_PROVIDER_RUNTIME_STATE_PATH"))
	runtimes := newMemoryRuntimeEndpointStore()
	if runtimeStatePath != "" {
		runtimes, err = openRuntimeEndpointStore(runtimeStatePath, runtimeAdapterRegistry())
		if err != nil {
			logger.Error("provider_agent_configuration_invalid", "error", err.Error())
			os.Exit(2)
		}
	}
	deviceKeyPath := strings.TrimSpace(os.Getenv("MULTIVIBE_PROVIDER_DEVICE_KEY_PATH"))
	var identity *deviceIdentity
	if deviceKeyPath != "" {
		identity, err = openDeviceIdentity(deviceKeyPath)
		if err != nil {
			logger.Error("provider_agent_configuration_invalid", "error", err.Error())
			os.Exit(2)
		}
	}
	controlToken := strings.TrimSpace(os.Getenv("MULTIVIBE_PROVIDER_CONTROL_TOKEN"))
	if controlToken != "" && len(controlToken) < 32 {
		logger.Error("provider_agent_configuration_invalid", "error", "provider control token must contain at least 32 characters")
		os.Exit(2)
	}
	listenAddress, err := loopbackAgentAddress(envDefault("MULTIVIBE_PROVIDER_AGENT_LISTEN", "127.0.0.1:1460"))
	if err != nil {
		logger.Error("provider_agent_configuration_invalid", "error", err.Error())
		os.Exit(2)
	}
	if err := validateAdapterRegistry(runtimeAdapterRegistry()); err != nil {
		logger.Error("provider_agent_configuration_invalid", "error", err.Error())
		os.Exit(2)
	}
	client := &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	listener, err := net.Listen("tcp", listenAddress)
	if err != nil {
		logger.Error("provider_agent_listen_failed", "error", err.Error())
		os.Exit(1)
	}
	logger.Info("provider_agent_started", "address", listener.Addr().String(), "selected_model_count", len(selections.snapshot().SelectedModels), "selection_persistent", statePath != "", "manual_runtime_count", len(runtimes.snapshot().Endpoints), "runtime_state_persistent", runtimeStatePath != "", "device_identity_persistent", deviceKeyPath != "")
	server := &http.Server{Handler: providerHandlerWithStoresAndIdentity(core, selections, runtimes, identity, client, controlToken), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second}
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logger.Error("provider_agent_failed", "error", fmt.Sprint(err))
		os.Exit(1)
	}
}

func envDefault(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
