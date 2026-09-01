package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
)

type manifest struct {
	ProtocolVersion string   `json:"protocol_version"`
	State           string   `json:"state"`
	SelectedModels  []string `json:"selected_models"`
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
	if err := json.Unmarshal([]byte(raw), &models); err != nil || len(models) > 100 {
		return nil, errors.New("selected model allowlist is invalid")
	}
	seen := make(map[string]struct{}, len(models))
	for _, model := range models {
		if !validSelectedModelID(model) {
			return nil, errors.New("selected model allowlist contains an invalid id")
		}
		if _, exists := seen[model]; exists {
			return nil, errors.New("selected model allowlist contains duplicate ids")
		}
		seen[model] = struct{}{}
	}
	sort.Strings(models)
	return models, nil
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
		response.Header().Set("cache-control", "no-store")
		response.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(response).Encode(manifest{ProtocolVersion: "provider-agent-v1", State: string(selectedManifestState(models)), SelectedModels: models})
	})
	mux.HandleFunc("GET /v1/adapters", func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("cache-control", "no-store")
		response.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(response).Encode(runtimeAdapterRegistry())
	})
	return mux
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
	logger.Info("provider_agent_started", "address", listener.Addr().String(), "selected_model_count", len(models))
	server := &http.Server{Handler: providerHandler(core, models, client), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second}
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
