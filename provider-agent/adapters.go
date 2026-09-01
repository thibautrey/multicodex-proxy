package main

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
)

const adapterRegistrySchemaVersion = "provider-runtime-registry-v1"

type adapterLimits struct {
	MaxCatalogModels int `json:"max_catalog_models"`
	MaxResponseBytes int `json:"max_response_bytes"`
	TimeoutMS        int `json:"timeout_ms"`
}

type adapterCandidate struct {
	Endpoint   string `json:"endpoint"`
	HealthURL  string `json:"health_url"`
	CatalogURL string `json:"catalog_url"`
}

type runtimeAdapter struct {
	ID             string             `json:"id"`
	DisplayName    string             `json:"display_name"`
	Protocol       string             `json:"protocol"`
	HealthPath     string             `json:"health_path"`
	CatalogPath    string             `json:"catalog_path"`
	Capabilities   []string           `json:"capabilities"`
	Authentication string             `json:"authentication"`
	Measurement    []string           `json:"measurement"`
	Limits         adapterLimits      `json:"limits"`
	Candidates     []adapterCandidate `json:"automatic_loopback_candidates"`
}

type adapterRegistryDocument struct {
	SchemaVersion string           `json:"schema_version"`
	Adapters      []runtimeAdapter `json:"adapters"`
}

func manualOpenAIAdapter(id, displayName string) runtimeAdapter {
	return runtimeAdapter{
		ID:             id,
		DisplayName:    displayName,
		Protocol:       "openai-compatible",
		HealthPath:     "/v1/models",
		CatalogPath:    "/v1/models",
		Capabilities:   []string{"text", "embeddings", "tools"},
		Authentication: "optional-bearer",
		Measurement:    []string{"input_text_token", "output_text_token", "request"},
		Limits: adapterLimits{
			MaxCatalogModels: 10_000,
			MaxResponseBytes: 256 * 1024,
			TimeoutMS:        1_500,
		},
		Candidates: []adapterCandidate{},
	}
}

var runtimeAdapters = func() []runtimeAdapter {
	lmStudio := manualOpenAIAdapter("lm-studio", "LM Studio")
	lmStudio.Authentication = "none"
	lmStudio.Candidates = []adapterCandidate{
		{
			Endpoint:   "http://127.0.0.1:1234",
			HealthURL:  "http://127.0.0.1:1234/v1/models",
			CatalogURL: "http://127.0.0.1:1234/v1/models",
		},
		{
			Endpoint:   "http://[::1]:1234",
			HealthURL:  "http://[::1]:1234/v1/models",
			CatalogURL: "http://[::1]:1234/v1/models",
		},
	}
	return []runtimeAdapter{
		manualOpenAIAdapter("ollama", "Ollama"),
		lmStudio,
		manualOpenAIAdapter("llama-cpp", "llama.cpp / llama-server / llama-cpp-python"),
		manualOpenAIAdapter("vllm", "vLLM"),
		manualOpenAIAdapter("sglang", "SGLang"),
		manualOpenAIAdapter("localai", "LocalAI"),
		manualOpenAIAdapter("huggingface-tgi", "Hugging Face TGI"),
		manualOpenAIAdapter("transformers-serve", "Transformers Serve"),
		manualOpenAIAdapter("xinference", "Xinference"),
		manualOpenAIAdapter("mlx-lm", "MLX-LM"),
		manualOpenAIAdapter("omlx", "OMLX"),
		manualOpenAIAdapter("mlc-llm", "MLC LLM"),
		manualOpenAIAdapter("exo", "Exo"),
		manualOpenAIAdapter("jan", "Jan"),
		manualOpenAIAdapter("gpt4all", "GPT4All"),
		manualOpenAIAdapter("koboldcpp", "KoboldCpp"),
		manualOpenAIAdapter("text-generation-webui", "text-generation-webui"),
		manualOpenAIAdapter("aphrodite", "Aphrodite"),
		manualOpenAIAdapter("tabbyapi", "TabbyAPI"),
		manualOpenAIAdapter("llama-box", "llama-box"),
		manualOpenAIAdapter("mistral-rs", "mistral.rs"),
		manualOpenAIAdapter("nvidia-nim", "NVIDIA NIM"),
		manualOpenAIAdapter("tensorrt-llm", "TensorRT-LLM"),
		manualOpenAIAdapter("triton", "NVIDIA Triton"),
		manualOpenAIAdapter("openllm", "OpenLLM"),
		manualOpenAIAdapter("bentoml", "BentoML"),
		manualOpenAIAdapter("mtplx", "MTPLX"),
		manualOpenAIAdapter("manual-openai-compatible", "Manual OpenAI-compatible server"),
	}
}()

func runtimeAdapterRegistry() adapterRegistryDocument {
	return adapterRegistryDocument{SchemaVersion: adapterRegistrySchemaVersion, Adapters: runtimeAdapters}
}

func validateAdapterRegistry(registry adapterRegistryDocument) error {
	if registry.SchemaVersion != adapterRegistrySchemaVersion || len(registry.Adapters) != 28 {
		return errors.New("provider runtime registry has an invalid schema or adapter count")
	}
	seen := make(map[string]struct{}, len(registry.Adapters))
	for _, adapter := range registry.Adapters {
		if adapter.ID == "" || len(adapter.ID) > 64 || adapter.DisplayName == "" || len(adapter.DisplayName) > 128 {
			return errors.New("provider runtime registry contains an invalid identity")
		}
		if _, exists := seen[adapter.ID]; exists {
			return fmt.Errorf("provider runtime registry contains duplicate adapter %s", adapter.ID)
		}
		seen[adapter.ID] = struct{}{}
		if adapter.Protocol != "openai-compatible" && adapter.Protocol != "native" {
			return fmt.Errorf("provider runtime adapter %s has an invalid protocol", adapter.ID)
		}
		if !validAdapterPath(adapter.HealthPath) || !validAdapterPath(adapter.CatalogPath) {
			return fmt.Errorf("provider runtime adapter %s has an invalid probe path", adapter.ID)
		}
		if len(adapter.Capabilities) == 0 || len(adapter.Capabilities) > 8 || len(adapter.Measurement) == 0 || len(adapter.Measurement) > 8 {
			return fmt.Errorf("provider runtime adapter %s has an invalid capability contract", adapter.ID)
		}
		if adapter.Authentication != "none" && adapter.Authentication != "optional-bearer" && adapter.Authentication != "required-bearer" {
			return fmt.Errorf("provider runtime adapter %s has an invalid authentication contract", adapter.ID)
		}
		if adapter.Limits.MaxCatalogModels < 1 || adapter.Limits.MaxCatalogModels > 10_000 ||
			adapter.Limits.MaxResponseBytes < 1 || adapter.Limits.MaxResponseBytes > 1024*1024 ||
			adapter.Limits.TimeoutMS < 1 || adapter.Limits.TimeoutMS > 5_000 || len(adapter.Candidates) > 4 {
			return fmt.Errorf("provider runtime adapter %s has invalid limits", adapter.ID)
		}
		if (adapter.ID == "lm-studio" && len(adapter.Candidates) != 2) ||
			(adapter.ID != "lm-studio" && len(adapter.Candidates) != 0) {
			return fmt.Errorf("provider runtime adapter %s has unreviewed automatic candidates", adapter.ID)
		}
		for _, candidate := range adapter.Candidates {
			if err := validateLoopbackCandidate(adapter, candidate); err != nil {
				return err
			}
		}
	}
	return nil
}

func validAdapterPath(value string) bool {
	return strings.HasPrefix(value, "/") && len(value) <= 128 && !strings.ContainsAny(value, "?#\r\n")
}

func validateLoopbackCandidate(adapter runtimeAdapter, candidate adapterCandidate) error {
	endpoint, err := url.Parse(candidate.Endpoint)
	if err != nil || endpoint.Scheme != "http" || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" ||
		(endpoint.Hostname() != "127.0.0.1" && endpoint.Hostname() != "::1") || endpoint.Port() == "" ||
		(endpoint.Path != "" && endpoint.Path != "/") {
		return fmt.Errorf("provider runtime adapter %s has a non-loopback automatic candidate", adapter.ID)
	}
	for _, raw := range []string{candidate.HealthURL, candidate.CatalogURL} {
		probe, probeErr := url.Parse(raw)
		if probeErr != nil || probe.Scheme != "http" || probe.User != nil || probe.RawQuery != "" || probe.Fragment != "" ||
			probe.Hostname() != endpoint.Hostname() || probe.Port() != endpoint.Port() {
			return fmt.Errorf("provider runtime adapter %s has an invalid automatic probe", adapter.ID)
		}
	}
	health, _ := url.Parse(candidate.HealthURL)
	catalog, _ := url.Parse(candidate.CatalogURL)
	if health.Path != adapter.HealthPath || catalog.Path != adapter.CatalogPath {
		return fmt.Errorf("provider runtime adapter %s candidate does not match its probe contract", adapter.ID)
	}
	approved := (candidate.Endpoint == "http://127.0.0.1:1234" &&
		candidate.HealthURL == "http://127.0.0.1:1234/v1/models" &&
		candidate.CatalogURL == "http://127.0.0.1:1234/v1/models") ||
		(candidate.Endpoint == "http://[::1]:1234" &&
			candidate.HealthURL == "http://[::1]:1234/v1/models" &&
			candidate.CatalogURL == "http://[::1]:1234/v1/models")
	if adapter.ID != "lm-studio" || !approved {
		return fmt.Errorf("provider runtime adapter %s candidate is outside the reviewed port allowlist", adapter.ID)
	}
	return nil
}
