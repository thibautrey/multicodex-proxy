package main

import (
	"context"
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
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode"
)

const (
	providerAgentReadHeaderTimeout = 5 * time.Second
	providerAgentReadTimeout       = 10 * time.Second
	providerAgentWriteTimeout      = managedOllamaDefaultInstallTimeout + time.Minute
	providerAgentIdleTimeout       = 30 * time.Second
	providerAgentMaxHeaderBytes    = 32 * 1024
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
	return providerHandlerWithServices(core, selections, runtimes, identity, nil, client, controlToken)
}

func providerHandlerWithServices(core *url.URL, selections *selectionStore, runtimes *runtimeEndpointStore, identity *deviceIdentity, enrollment *cloudEnrollmentService, client *http.Client, controlToken string) http.Handler {
	return providerHandlerWithAllServices(core, selections, runtimes, identity, enrollment, nil, client, controlToken)
}

func providerHandlerWithAllServices(core *url.URL, selections *selectionStore, runtimes *runtimeEndpointStore, identity *deviceIdentity, enrollment *cloudEnrollmentService, capacity *capacityPolicyStore, client *http.Client, controlToken string) http.Handler {
	return providerHandlerWithDemandService(core, selections, runtimes, identity, enrollment, capacity, nil, client, controlToken)
}

func providerHandlerWithDemandService(core *url.URL, selections *selectionStore, runtimes *runtimeEndpointStore, identity *deviceIdentity, enrollment *cloudEnrollmentService, capacity *capacityPolicyStore, demand *providerDemandService, client *http.Client, controlToken string) http.Handler {
	return providerHandlerWithManagedController(core, selections, runtimes, identity, enrollment, capacity, demand, nil, client, controlToken)
}

func providerHandlerWithManagedController(core *url.URL, selections *selectionStore, runtimes *runtimeEndpointStore, identity *deviceIdentity, enrollment *cloudEnrollmentService, capacity *capacityPolicyStore, demand *providerDemandService, controller *managedProviderController, client *http.Client, controlToken string) http.Handler {
	return providerHandlerWithManagedControllerAndCapability(core, selections, runtimes, identity, enrollment, capacity, demand, controller, hostCapability{}, client, controlToken)
}

func providerHandlerWithManagedControllerAndCapability(core *url.URL, selections *selectionStore, runtimes *runtimeEndpointStore, identity *deviceIdentity, enrollment *cloudEnrollmentService, capacity *capacityPolicyStore, demand *providerDemandService, controller *managedProviderController, capability hostCapability, client *http.Client, controlToken string) http.Handler {
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
		state := document.State
		if enrollment != nil && enrollment.store.snapshot() != nil {
			state = string(StateSubmitted)
		}
		keyID := ""
		publicKeySPKI := ""
		if identity != nil {
			keyID, publicKeySPKI = identity.publicIdentity()
		}
		response.Header().Set("cache-control", "no-store")
		response.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(response).Encode(manifest{
			ProtocolVersion: "provider-agent-v1", State: state, SelectedModels: document.SelectedModels,
			DeviceKeyID: keyID, DevicePublicKeySPKI: publicKeySPKI,
		})
	})
	mux.HandleFunc("GET /v1/capability", func(response http.ResponseWriter, request *http.Request) {
		if !authorizeProviderControl(request, controlToken) {
			http.Error(response, "not found", http.StatusNotFound)
			return
		}
		response.Header().Set("cache-control", "no-store")
		response.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(response).Encode(capability)
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
		if enrollment != nil && enrollment.store.snapshot() != nil {
			response.Header().Set("cache-control", "no-store")
			response.Header().Set("content-type", "application/json")
			response.WriteHeader(http.StatusConflict)
			_ = json.NewEncoder(response).Encode(selections.snapshot())
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
	mux.HandleFunc("GET /v1/capacity-policy", func(response http.ResponseWriter, request *http.Request) {
		if !authorizeProviderControl(request, controlToken) {
			http.Error(response, "not found", http.StatusNotFound)
			return
		}
		if capacity == nil {
			http.Error(response, "provider capacity policy unavailable", http.StatusServiceUnavailable)
			return
		}
		document := capacity.snapshot()
		if document == nil {
			http.Error(response, "provider capacity policy not found", http.StatusNotFound)
			return
		}
		response.Header().Set("cache-control", "no-store")
		response.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(response).Encode(document)
	})
	mux.HandleFunc("PUT /v1/capacity-policy", func(response http.ResponseWriter, request *http.Request) {
		if !authorizeProviderControl(request, controlToken) {
			http.Error(response, "not found", http.StatusNotFound)
			return
		}
		if capacity == nil {
			http.Error(response, "provider capacity policy unavailable", http.StatusServiceUnavailable)
			return
		}
		mediaType, _, mediaTypeErr := mime.ParseMediaType(request.Header.Get("content-type"))
		if mediaTypeErr != nil || mediaType != "application/json" {
			http.Error(response, "invalid request", http.StatusUnsupportedMediaType)
			return
		}
		request.Body = http.MaxBytesReader(response, request.Body, 32*1024)
		var input capacityPolicyStateDocument
		decoder := json.NewDecoder(request.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&input); err != nil || ensureJSONEOF(decoder) != nil || input.SchemaVersion != capacityPolicyStateSchemaVersion {
			http.Error(response, "invalid request", http.StatusBadRequest)
			return
		}
		expectedRevision := input.Revision
		document, conflict, err := capacity.replace(expectedRevision, input)
		if err != nil {
			if errors.Is(err, errInvalidCapacityPolicy) {
				http.Error(response, "invalid request", http.StatusBadRequest)
				return
			}
			http.Error(response, "capacity policy unavailable", http.StatusInternalServerError)
			return
		}
		if !conflict && controller != nil {
			if err := controller.enforceCurrentPolicy(request.Context()); err != nil {
				http.Error(response, "capacity policy enforcement unavailable", http.StatusServiceUnavailable)
				return
			}
		}
		response.Header().Set("cache-control", "no-store")
		response.Header().Set("content-type", "application/json")
		if conflict {
			response.WriteHeader(http.StatusConflict)
		}
		_ = json.NewEncoder(response).Encode(document)
	})
	mux.HandleFunc("GET /v1/managed-ollama/status", func(response http.ResponseWriter, request *http.Request) {
		if !authorizeProviderControl(request, controlToken) {
			http.Error(response, "not found", http.StatusNotFound)
			return
		}
		if controller == nil {
			http.Error(response, "managed Ollama unavailable", http.StatusServiceUnavailable)
			return
		}
		writeManagedControllerView(response, controller.status())
	})
	for path, action := range map[string]string{
		"/v1/managed-ollama/install":   "install",
		"/v1/managed-ollama/start":     "start",
		"/v1/managed-ollama/stop":      "stop",
		"/v1/managed-ollama/reconcile": "reconcile",
	} {
		path := path
		action := action
		mux.HandleFunc("POST "+path, func(response http.ResponseWriter, request *http.Request) {
			if !authorizeProviderControl(request, controlToken) {
				http.Error(response, "not found", http.StatusNotFound)
				return
			}
			if controller == nil {
				http.Error(response, "managed Ollama unavailable", http.StatusServiceUnavailable)
				return
			}
			mediaType, _, mediaTypeErr := mime.ParseMediaType(request.Header.Get("content-type"))
			if mediaTypeErr != nil || mediaType != "application/json" {
				http.Error(response, "invalid request", http.StatusUnsupportedMediaType)
				return
			}
			request.Body = http.MaxBytesReader(response, request.Body, 4096)
			if action == "stop" {
				var input struct{}
				decoder := json.NewDecoder(request.Body)
				decoder.DisallowUnknownFields()
				if decoder.Decode(&input) != nil || ensureJSONEOF(decoder) != nil {
					http.Error(response, "invalid request", http.StatusBadRequest)
					return
				}
				view, err := controller.stop(request.Context())
				if err != nil {
					http.Error(response, "managed Ollama stop unavailable", http.StatusServiceUnavailable)
					return
				}
				writeManagedControllerView(response, view)
				return
			}
			fence, err := decodeManagedControllerFence(request.Body, action == "reconcile")
			if err != nil {
				http.Error(response, "invalid request", http.StatusBadRequest)
				return
			}
			var view managedControllerView
			switch action {
			case "install":
				view, err = controller.install(request.Context(), fence.PolicyRevision)
			case "start":
				view, err = controller.start(request.Context(), fence.PolicyRevision)
			case "reconcile":
				view, err = controller.reconcile(request.Context(), fence)
			}
			if err != nil {
				writeManagedControllerError(response, err)
				return
			}
			writeManagedControllerView(response, view)
		})
	}
	mux.HandleFunc("GET /v1/cloud-shadow/demand-plan", func(response http.ResponseWriter, request *http.Request) {
		if !authorizeProviderControl(request, controlToken) {
			http.Error(response, "not found", http.StatusNotFound)
			return
		}
		if demand == nil {
			http.Error(response, "provider demand planning unavailable", http.StatusServiceUnavailable)
			return
		}
		document := demand.plans.snapshot()
		if document == nil {
			http.Error(response, "provider demand plan not found", http.StatusNotFound)
			return
		}
		response.Header().Set("cache-control", "no-store")
		response.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(response).Encode(document)
	})
	mux.HandleFunc("POST /v1/cloud-shadow/demand", func(response http.ResponseWriter, request *http.Request) {
		if !authorizeProviderControl(request, controlToken) {
			http.Error(response, "not found", http.StatusNotFound)
			return
		}
		if demand == nil {
			http.Error(response, "provider demand planning unavailable", http.StatusServiceUnavailable)
			return
		}
		mediaType, _, mediaTypeErr := mime.ParseMediaType(request.Header.Get("content-type"))
		if mediaTypeErr != nil || mediaType != "application/json" {
			http.Error(response, "invalid request", http.StatusUnsupportedMediaType)
			return
		}
		request.Body = http.MaxBytesReader(response, request.Body, maximumProviderDemandBytes)
		raw, err := decodeProviderDemandRequest(request.Body)
		if err != nil {
			http.Error(response, "invalid request", http.StatusBadRequest)
			return
		}
		document, status, err := demand.accept(raw)
		if err != nil {
			switch {
			case errors.Is(err, errInvalidProviderDemand):
				http.Error(response, "invalid request", http.StatusBadRequest)
			case errors.Is(err, errProviderDemandGenerationConflict), errors.Is(err, errProviderDemandGenerationStale), errors.Is(err, errProviderCapacityNotAuthorized):
				http.Error(response, "provider demand rejected", http.StatusConflict)
			default:
				http.Error(response, "provider demand planning unavailable", http.StatusServiceUnavailable)
			}
			return
		}
		response.Header().Set("cache-control", "no-store")
		response.Header().Set("content-type", "application/json")
		if status == "accepted" {
			response.WriteHeader(http.StatusCreated)
		}
		_ = json.NewEncoder(response).Encode(document)
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
	mux.HandleFunc("GET /v1/cloud-shadow/enrollment", func(response http.ResponseWriter, request *http.Request) {
		if !authorizeProviderControl(request, controlToken) {
			http.Error(response, "not found", http.StatusNotFound)
			return
		}
		if enrollment == nil {
			http.Error(response, "provider Cloud enrollment unavailable", http.StatusServiceUnavailable)
			return
		}
		view := enrollment.store.snapshot()
		if view == nil {
			http.Error(response, "provider Cloud enrollment not found", http.StatusNotFound)
			return
		}
		response.Header().Set("cache-control", "no-store")
		response.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(response).Encode(view)
	})
	mux.HandleFunc("POST /v1/cloud-shadow/enroll", func(response http.ResponseWriter, request *http.Request) {
		if !authorizeProviderControl(request, controlToken) {
			http.Error(response, "not found", http.StatusNotFound)
			return
		}
		if enrollment == nil {
			http.Error(response, "provider Cloud enrollment unavailable", http.StatusServiceUnavailable)
			return
		}
		mediaType, _, mediaTypeErr := mime.ParseMediaType(request.Header.Get("content-type"))
		if mediaTypeErr != nil || mediaType != "application/json" {
			http.Error(response, "invalid request", http.StatusUnsupportedMediaType)
			return
		}
		request.Body = http.MaxBytesReader(response, request.Body, maxCloudEnrollmentBodyBytes)
		var input cloudEnrollmentInput
		decoder := json.NewDecoder(request.Body)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&input); err != nil || ensureJSONEOF(decoder) != nil {
			http.Error(response, "invalid request", http.StatusBadRequest)
			return
		}
		view, err := enrollment.enroll(request.Context(), input)
		if err != nil {
			if errors.Is(err, errInvalidCloudEnrollment) {
				http.Error(response, "invalid request", http.StatusBadRequest)
				return
			}
			if errors.Is(err, errCloudAlreadyEnrolled) {
				http.Error(response, "already enrolled", http.StatusConflict)
				return
			}
			http.Error(response, "provider Cloud enrollment failed", http.StatusBadGateway)
			return
		}
		response.Header().Set("cache-control", "no-store")
		response.Header().Set("content-type", "application/json")
		response.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(response).Encode(view)
	})
	return mux
}

func writeManagedControllerView(response http.ResponseWriter, view managedControllerView) {
	response.Header().Set("cache-control", "no-store")
	response.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(response).Encode(view)
}

func writeManagedControllerError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errManagedControllerFence), errors.Is(err, errManagedControllerNoPlan), errors.Is(err, errManagedControllerPlanExpired),
		errors.Is(err, errManagedControllerConsent), errors.Is(err, errManagedControllerSuperseded), errors.Is(err, errManagedOllamaPaused),
		errors.Is(err, errManagedOllamaDownloadsDisabled), errors.Is(err, errManagedOllamaPolicyRequired):
		http.Error(response, "managed Ollama operation rejected", http.StatusConflict)
	default:
		http.Error(response, "managed Ollama operation unavailable", http.StatusServiceUnavailable)
	}
}

func authorizeProviderControl(request *http.Request, expected string) bool {
	if len(expected) < 32 {
		return false
	}
	provided := strings.TrimPrefix(request.Header.Get("authorization"), "Bearer ")
	return len(provided) == len(expected) && subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

func newProviderHTTPServer(handler http.Handler) *http.Server {
	return &http.Server{
		Handler: handler, ReadHeaderTimeout: providerAgentReadHeaderTimeout, ReadTimeout: providerAgentReadTimeout,
		WriteTimeout: providerAgentWriteTimeout, IdleTimeout: providerAgentIdleTimeout, MaxHeaderBytes: providerAgentMaxHeaderBytes,
	}
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "doctor":
			os.Exit(runDoctor(os.Stdout))
		case "version", "--version", "-version":
			_, _ = fmt.Fprintln(os.Stdout, providerAgentVersion)
			return
		default:
			logger.Error("provider_agent_command_invalid")
			os.Exit(2)
		}
	}
	capability := currentHostCapability()
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
	cloudURL, err := cloudAPIURL(envDefault("MULTIVIBE_CLOUD_API_URL", "https://api.multivibe.cloud"))
	if err != nil {
		logger.Error("provider_agent_configuration_invalid", "error", err.Error())
		os.Exit(2)
	}
	enrollmentStatePath := strings.TrimSpace(os.Getenv("MULTIVIBE_PROVIDER_ENROLLMENT_STATE_PATH"))
	enrollmentStore := newMemoryCloudEnrollmentStore()
	if enrollmentStatePath != "" {
		enrollmentStore, err = openCloudEnrollmentStore(enrollmentStatePath)
		if err != nil {
			logger.Error("provider_agent_configuration_invalid", "error", err.Error())
			os.Exit(2)
		}
	}
	capacityPolicyPath := strings.TrimSpace(os.Getenv("MULTIVIBE_PROVIDER_CAPACITY_POLICY_PATH"))
	capacity := newMemoryCapacityPolicyStore()
	if capacityPolicyPath != "" {
		capacity, err = openCapacityPolicyStore(capacityPolicyPath)
		if err != nil {
			logger.Error("provider_agent_configuration_invalid", "error", err.Error())
			os.Exit(2)
		}
	}
	demandPlanPath := strings.TrimSpace(os.Getenv("MULTIVIBE_PROVIDER_DEMAND_PLAN_PATH"))
	modelCatalogPath := strings.TrimSpace(os.Getenv("MULTIVIBE_PROVIDER_MODEL_CATALOG_PATH"))
	trustedDemandKeysRaw := strings.TrimSpace(os.Getenv("MULTIVIBE_PROVIDER_DEMAND_TRUSTED_KEYS"))
	var demand *providerDemandService
	var plans *providerDemandPlanStore
	demandConfigurationFields := 0
	for _, value := range []string{demandPlanPath, modelCatalogPath, trustedDemandKeysRaw} {
		if value != "" {
			demandConfigurationFields++
		}
	}
	if demandConfigurationFields != 0 && demandConfigurationFields != 3 {
		logger.Error("provider_agent_configuration_invalid", "error", "provider demand planning requires plan path, model catalog and trusted keys")
		os.Exit(2)
	}
	if demandConfigurationFields == 3 {
		catalog, catalogErr := openProviderModelCatalog(modelCatalogPath)
		trustedKeys, keysErr := parseTrustedProviderDemandKeys(trustedDemandKeysRaw)
		capabilityErr := requireProviderComputeCapability(capability, true)
		var plansErr error
		plans, plansErr = openProviderDemandPlanStore(demandPlanPath)
		if catalogErr != nil || keysErr != nil || plansErr != nil || capabilityErr != nil {
			logger.Error("provider_agent_configuration_invalid", "error", "provider demand planning configuration is invalid")
			os.Exit(2)
		}
		demand, err = newProviderDemandService(trustedKeys, catalog, capacity, plans, capability)
		if err != nil {
			logger.Error("provider_agent_configuration_invalid", "error", err.Error())
			os.Exit(2)
		}
	}
	managedRoot := strings.TrimSpace(os.Getenv("MULTIVIBE_PROVIDER_MANAGED_ROOT"))
	bundledOllamaRoot := strings.TrimSpace(os.Getenv("MULTIVIBE_PROVIDER_BUNDLED_OLLAMA_ROOT"))
	dependencyManifestPath := strings.TrimSpace(os.Getenv("MULTIVIBE_PROVIDER_DEPENDENCY_MANIFEST_PATH"))
	managedPlannerStatePath := strings.TrimSpace(os.Getenv("MULTIVIBE_PROVIDER_MANAGED_PLANNER_STATE_PATH"))
	ollamaListenAddress := strings.TrimSpace(os.Getenv("MULTIVIBE_PROVIDER_OLLAMA_LISTEN"))
	cudaVisibleDevices := strings.TrimSpace(os.Getenv("MULTIVIBE_PROVIDER_CUDA_VISIBLE_DEVICES"))
	managedConfigurationFields := 0
	for _, value := range []string{managedRoot, dependencyManifestPath, managedPlannerStatePath} {
		if value != "" {
			managedConfigurationFields++
		}
	}
	var controller *managedProviderController
	if managedConfigurationFields != 0 || bundledOllamaRoot != "" || ollamaListenAddress != "" || cudaVisibleDevices != "" {
		if managedConfigurationFields != 3 || demand == nil || plans == nil || capacityPolicyPath == "" {
			logger.Error("provider_agent_configuration_invalid", "error", "managed Ollama requires its root, dependency manifest, planner state, capacity policy and signed demand planning")
			os.Exit(2)
		}
		if err := requireProviderComputeCapability(capability, true); err != nil {
			logger.Error("provider_agent_platform_unsupported", "reason", capability.Reason)
			os.Exit(2)
		}
		if ollamaListenAddress == "" {
			ollamaListenAddress = managedOllamaDefaultListenAddress
		}
		if capability.OS == "linux" && cudaVisibleDevices == "" {
			cudaVisibleDevices = "0"
		}
		managedRuntime, runtimeErr := newManagedOllama(managedOllamaConfig{
			ManagedRoot: managedRoot, BundledRuntimeRoot: bundledOllamaRoot, ListenAddress: ollamaListenAddress,
			CUDAVisibleDevices: cudaVisibleDevices, GOOS: capability.OS, GOARCH: capability.Architecture,
		})
		plannerState, plannerErr := openManagedPlannerStateStore(managedPlannerStatePath)
		if runtimeErr != nil || plannerErr != nil {
			logger.Error("provider_agent_configuration_invalid", "error", "managed Ollama runtime configuration is invalid")
			os.Exit(2)
		}
		managedBackend, backendErr := newOllamaRuntimeBackend(managedRuntime, modelCatalogPath, dependencyManifestPath)
		backendRegistry, registryErr := newRuntimeBackendRegistry(managedBackend)
		sdkRegistry, sdkRegistryErr := newRuntimeBackendSDKRegistry(managedBackend, capacity, capability)
		if backendErr != nil || registryErr != nil || sdkRegistryErr != nil ||
			strings.Join(backendRegistry.IDs(), ",") != runtimeBackendOllamaID || strings.Join(sdkRegistry.IDs(), ",") != runtimeBackendOllamaID {
			logger.Error("provider_agent_configuration_invalid", "error", "managed runtime backend registry is invalid")
			os.Exit(2)
		}
		controllerStatePath := filepath.Join(managedRoot, "state", "controller.json")
		controller, err = newManagedProviderController(
			managedBackend, capacity, plans, plannerState, modelCatalogPath, dependencyManifestPath, controllerStatePath,
		)
		if err != nil {
			logger.Error("provider_agent_configuration_invalid", "error", err.Error())
			os.Exit(2)
		}
		demand.state = controller.plannerSnapshot
	}
	if demand != nil {
		if err := demand.restorePersisted(); err != nil {
			logger.Warn("provider_demand_persisted_envelope_rejected")
		}
	}
	if controller != nil {
		go controller.monitorPolicy(context.Background())
		go controller.monitorPlanExpiry(context.Background())
	}
	controlToken := strings.TrimSpace(os.Getenv("MULTIVIBE_PROVIDER_CONTROL_TOKEN"))
	if controlToken != "" && len(controlToken) < 32 {
		logger.Error("provider_agent_configuration_invalid", "error", "provider control token must contain at least 32 characters")
		os.Exit(2)
	}
	bootstrap, err := inheritedProviderAgentBootstrap(os.Getenv(providerAgentBootstrapEnvironment))
	if err != nil {
		logger.Error("provider_agent_configuration_invalid", "error", err.Error())
		os.Exit(2)
	}
	listenAddress := ""
	if bootstrap == nil {
		listenAddress, err = loopbackAgentAddress(envDefault("MULTIVIBE_PROVIDER_AGENT_LISTEN", "127.0.0.1:1460"))
	} else {
		listenAddress, err = supervisedLoopbackAgentAddress(envDefault("MULTIVIBE_PROVIDER_AGENT_LISTEN", "127.0.0.1:0"))
	}
	if err != nil {
		logger.Error("provider_agent_configuration_invalid", "error", err.Error())
		os.Exit(2)
	}
	if err := validateAdapterRegistry(runtimeAdapterRegistry()); err != nil {
		logger.Error("provider_agent_configuration_invalid", "error", err.Error())
		os.Exit(2)
	}
	client := &http.Client{Timeout: 2 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}
	var enrollment *cloudEnrollmentService
	if identity != nil {
		enrollment = newCloudEnrollmentService(cloudURL, client, identity, selections, enrollmentStore)
	}
	listener, err := openProviderAgentListener(listenAddress, bootstrap)
	if err != nil {
		logger.Error("provider_agent_listen_failed", "error", err.Error())
		os.Exit(1)
	}
	logger.Info("provider_agent_started", "address", listener.Addr().String(), "selected_model_count", len(selections.snapshot().SelectedModels), "selection_persistent", statePath != "", "manual_runtime_count", len(runtimes.snapshot().Endpoints), "runtime_state_persistent", runtimeStatePath != "", "device_identity_persistent", deviceKeyPath != "", "cloud_enrollment_persistent", enrollmentStatePath != "", "capacity_policy_configured", capacity.snapshot() != nil, "capacity_policy_persistent", capacityPolicyPath != "", "demand_planning_enabled", demand != nil, "demand_plan_persistent", demandPlanPath != "", "managed_ollama_enabled", controller != nil)
	server := newProviderHTTPServer(providerHandlerWithManagedControllerAndCapability(core, selections, runtimes, identity, enrollment, capacity, demand, controller, capability, client, controlToken))
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

func requireProviderComputeCapability(capability hostCapability, managedComputeRequested bool) error {
	if !managedComputeRequested {
		return nil
	}
	if !capability.Supported {
		return errors.New("managed provider compute is unsupported on this host")
	}
	if _, err := providerAcceleratorMemoryCapacity(capability); err != nil {
		return errors.New("managed provider accelerator capacity is unavailable")
	}
	return nil
}
