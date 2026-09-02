package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func catalogResponse(status int, body string) *http.Response {
	return &http.Response{
		StatusCode:    status,
		Header:        make(http.Header),
		Body:          io.NopCloser(strings.NewReader(body)),
		ContentLength: int64(len(body)),
	}
}

func TestProbeRuntimeCatalogIsCredentialFreeBoundedAndDeterministic(t *testing.T) {
	adapter := runtimeAdapterRegistry().Adapters[1]
	candidate := adapter.Candidates[0]
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.String() != "http://127.0.0.1:1234/v1/models" || request.Method != http.MethodGet {
			t.Fatalf("unexpected catalog probe: %s %s", request.Method, request.URL)
		}
		if request.Header.Get("authorization") != "" || request.Header.Get("accept") != "application/json" {
			t.Fatalf("unexpected catalog probe headers: %#v", request.Header)
		}
		return catalogResponse(http.StatusOK, `{"object":"list","data":[{"id":"z/model"},{"id":"a/model"},{"id":"z/model"}]}`), nil
	})}

	models, err := probeRuntimeCatalog(context.Background(), adapter, candidate, client)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(models, ",") != "a/model,z/model" {
		t.Fatalf("unexpected detected models: %#v", models)
	}
}

func TestProbeRuntimeCatalogNeverFollowsRedirects(t *testing.T) {
	adapter := runtimeAdapterRegistry().Adapters[1]
	candidate := adapter.Candidates[0]
	calls := 0
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		calls++
		if request.URL.Hostname() != "127.0.0.1" {
			t.Fatalf("catalog probe escaped loopback: %s", request.URL)
		}
		response := catalogResponse(http.StatusFound, "")
		response.Header.Set("location", "https://remote.example/v1/models")
		response.Request = request
		return response, nil
	})}

	if _, err := probeRuntimeCatalog(context.Background(), adapter, candidate, client); err == nil {
		t.Fatal("redirected catalog must fail closed")
	}
	if calls != 1 {
		t.Fatalf("expected one loopback request, got %d", calls)
	}
}

func TestManualRuntimeProbeUsesOnlyTheConfiguredBearer(t *testing.T) {
	adapter := manualRuntimeAdapter(t)
	candidate := adapterCandidate{
		Endpoint: "http://127.0.0.1:8080", HealthURL: "http://127.0.0.1:8080/v1/models", CatalogURL: "http://127.0.0.1:8080/v1/models",
	}
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.String() != candidate.CatalogURL || request.Header.Get("authorization") != "Bearer local-runtime-token" {
			t.Fatalf("unexpected authenticated probe: %s %#v", request.URL, request.Header)
		}
		return catalogResponse(http.StatusOK, `{"data":[{"id":"publisher/model"}]}`), nil
	})}
	models, err := probeRuntimeCatalogAuthenticated(context.Background(), adapter, candidate, "local-runtime-token", client)
	if err != nil || !reflect.DeepEqual(models, []string{"publisher/model"}) {
		t.Fatalf("unexpected manual probe: models=%#v err=%v", models, err)
	}
}

func TestProbeRuntimeCatalogRejectsOversizedAndInvalidPayloads(t *testing.T) {
	adapter := runtimeAdapterRegistry().Adapters[1]
	candidate := adapter.Candidates[0]
	for name, body := range map[string]string{
		"oversized": strings.Repeat("x", adapter.Limits.MaxResponseBytes+1),
		"invalid":   `{"data":[{"id":"https://remote.example/model"}]}`,
	} {
		t.Run(name, func(t *testing.T) {
			client := &http.Client{Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
				return catalogResponse(http.StatusOK, body), nil
			})}
			if _, err := probeRuntimeCatalog(context.Background(), adapter, candidate, client); err == nil {
				t.Fatalf("%s payload must fail closed", name)
			}
		})
	}
}

func TestDetectedModelsEndpointReturnsOnlySuccessfulLoopbackInventory(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		calls++
		if calls <= 2 {
			expected := []string{"http://127.0.0.1:11434/v1/models", "http://[::1]:11434/v1/models"}[calls-1]
			if request.URL.String() != expected {
				t.Fatalf("unexpected Ollama probe: %s", request.URL)
			}
			return nil, errors.New("Ollama unavailable")
		}
		if calls == 3 {
			if request.URL.String() != "http://127.0.0.1:1234/v1/models" {
				t.Fatalf("unexpected LM Studio probe: %s", request.URL)
			}
			return nil, errors.New("IPv4 LM Studio unavailable")
		}
		if request.URL.String() != "http://[::1]:1234/v1/models" {
			t.Fatalf("unexpected fallback probe: %s", request.URL)
		}
		return catalogResponse(http.StatusOK, `{"data":[{"id":"publisher/model"}]}`), nil
	})}
	core, err := url.Parse("http://127.0.0.1:1455")
	if err != nil {
		t.Fatal(err)
	}
	token := strings.Repeat("c", 32)
	request := httptest.NewRequest(http.MethodGet, "/v1/detected-models", nil)
	request.Header.Set("authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	providerHandlerWithStores(core, newMemorySelectionStore([]string{}), newMemoryRuntimeEndpointStore(), client, token).ServeHTTP(response, request)

	if response.Code != http.StatusOK || response.Header().Get("cache-control") != "no-store" {
		t.Fatalf("unexpected endpoint response: %d %#v", response.Code, response.Header())
	}
	if response.Body.String() != `{"schema_version":"provider-detected-models-v1","runtimes":[{"adapter_id":"lm-studio","models":["publisher/model"]}]}`+"\n" {
		t.Fatalf("unexpected bounded inventory: %s", response.Body.String())
	}
	if calls != 4 {
		t.Fatalf("expected exactly four reviewed loopback attempts, got %d", calls)
	}
}
