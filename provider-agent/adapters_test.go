package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"testing"
)

func TestRuntimeAdapterRegistryIsCompleteAndBounded(t *testing.T) {
	registry := runtimeAdapterRegistry()
	if err := validateAdapterRegistry(registry); err != nil {
		t.Fatal(err)
	}
	expected := []string{
		"ollama", "lm-studio", "llama-cpp", "vllm", "sglang", "localai",
		"huggingface-tgi", "transformers-serve", "xinference", "mlx-lm", "omlx",
		"mlc-llm", "exo", "jan", "gpt4all", "koboldcpp", "text-generation-webui",
		"aphrodite", "tabbyapi", "llama-box", "mistral-rs", "nvidia-nim",
		"tensorrt-llm", "triton", "openllm", "bentoml", "mtplx", "manual-openai-compatible",
	}
	actual := make([]string, 0, len(registry.Adapters))
	automaticCandidates := 0
	for _, adapter := range registry.Adapters {
		actual = append(actual, adapter.ID)
		automaticCandidates += len(adapter.Candidates)
		if adapter.ID != "ollama" && adapter.ID != "lm-studio" && adapter.ID != "omlx" && adapter.ID != "exo" && adapter.ID != "mtplx" && len(adapter.Candidates) != 0 {
			t.Fatalf("%s must remain manual until an official probe is reviewed", adapter.ID)
		}
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("unexpected adapter registry: %#v", actual)
	}
	if automaticCandidates != 10 {
		t.Fatalf("expected only the ten reviewed loopback candidates, got %d", automaticCandidates)
	}
	ollama := registry.Adapters[0]
	if ollama.Authentication != "none" || len(ollama.Candidates) != 2 ||
		ollama.Candidates[0].Endpoint != "http://127.0.0.1:11434" ||
		ollama.Candidates[1].Endpoint != "http://[::1]:11434" {
		t.Fatalf("unexpected reviewed Ollama contract: %#v", ollama)
	}
	for _, id := range []string{"omlx", "mtplx", "exo"} {
		var adapter runtimeAdapter
		for _, candidate := range registry.Adapters {
			if candidate.ID == id {
				adapter = candidate
				break
			}
		}
		if len(adapter.Candidates) != 2 || adapter.Authentication != "none" {
			t.Fatalf("unexpected reviewed %s contract: %#v", id, adapter)
		}
	}
}

func TestProviderAgentListenAddressCannotLeaveLoopback(t *testing.T) {
	for _, allowed := range []string{"127.0.0.1:1460", "[::1]:1460"} {
		if _, err := loopbackAgentAddress(allowed); err != nil {
			t.Fatalf("expected %s to be allowed: %v", allowed, err)
		}
	}
	for _, denied := range []string{
		"localhost:1460", "0.0.0.0:1460", "192.168.1.10:1460", "127.0.0.1:1461", ":1460",
	} {
		if _, err := loopbackAgentAddress(denied); err == nil {
			t.Fatalf("expected %s to be denied", denied)
		}
	}
}

func TestRuntimeAdapterRegistryRejectsRemoteOrArbitraryCandidates(t *testing.T) {
	registry := runtimeAdapterRegistry()
	registry.Adapters = append([]runtimeAdapter(nil), registry.Adapters...)
	registry.Adapters[1].Candidates = []adapterCandidate{{
		Endpoint:   "http://192.168.1.10:1234",
		HealthURL:  "http://192.168.1.10:1234/v1/models",
		CatalogURL: "http://192.168.1.10:1234/v1/models",
	}}
	if err := validateAdapterRegistry(registry); err == nil {
		t.Fatal("a LAN candidate must be rejected")
	}

	registry = runtimeAdapterRegistry()
	registry.Adapters = append([]runtimeAdapter(nil), registry.Adapters...)
	registry.Adapters[1].Candidates = []adapterCandidate{{
		Endpoint:   "http://127.0.0.1:9999",
		HealthURL:  "http://127.0.0.1:9999/private",
		CatalogURL: "http://127.0.0.1:9999/v1/models",
	}}
	if err := validateAdapterRegistry(registry); err == nil {
		t.Fatal("an arbitrary loopback port and path must be rejected")
	}

	registry = runtimeAdapterRegistry()
	registry.Adapters = append([]runtimeAdapter(nil), registry.Adapters...)
	registry.Adapters[0].Candidates = []adapterCandidate{
		{
			Endpoint:   "http://127.0.0.1:11435",
			HealthURL:  "http://127.0.0.1:11435/v1/models",
			CatalogURL: "http://127.0.0.1:11435/v1/models",
		},
		registry.Adapters[0].Candidates[1],
	}
	if err := validateAdapterRegistry(registry); err == nil {
		t.Fatal("an unreviewed Ollama port must be rejected")
	}
}

func TestAdaptersEndpointExposesNoArbitraryNetworkTarget(t *testing.T) {
	core, err := url.Parse("http://127.0.0.1:1455")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodGet, "/v1/adapters", nil)
	response := httptest.NewRecorder()
	providerHandler(core, []string{}, http.DefaultClient).ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("cache-control") != "no-store" {
		t.Fatalf("unexpected response: %d %#v", response.Code, response.Header())
	}
	var document adapterRegistryDocument
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatal(err)
	}
	if err := validateAdapterRegistry(document); err != nil {
		t.Fatal(err)
	}
}
