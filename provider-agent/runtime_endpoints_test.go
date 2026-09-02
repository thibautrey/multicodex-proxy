package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func manualRuntimeAdapter(t *testing.T) runtimeAdapter {
	t.Helper()
	for _, adapter := range runtimeAdapterRegistry().Adapters {
		if adapter.ID == "manual-openai-compatible" {
			return adapter
		}
	}
	t.Fatal("manual OpenAI-compatible adapter is missing")
	return runtimeAdapter{}
}

func TestRuntimeEndpointStorePersistsSecretWithExactModeAndReturnsOnlyProof(t *testing.T) {
	path := filepath.Join(t.TempDir(), "provider-runtime-endpoints.json")
	store, err := openRuntimeEndpointStore(path, runtimeAdapterRegistry())
	if err != nil {
		t.Fatal(err)
	}
	token := "secret-known-only-to-the-local-runtime"
	updated, conflict, err := store.replaceInputs(1, []runtimeEndpointInput{{
		AdapterID: "manual-openai-compatible", Endpoint: "http://127.0.0.1:8080", BearerToken: &token,
	}}, runtimeAdapterRegistry())
	if err != nil || conflict || updated.Revision != 2 || updated.Endpoints[0].Authentication != "bearer" {
		t.Fatalf("unexpected runtime update: %#v conflict=%v err=%v", updated, conflict, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("runtime state must be mode 0600, got %o", info.Mode().Perm())
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(contents), token) {
		t.Fatal("the local bearer must be persisted for the supervised runtime")
	}
	view, err := json.Marshal(updated)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(view), token) || strings.Contains(string(view), "bearer_token") {
		t.Fatalf("runtime view leaked the local bearer: %s", view)
	}
	restarted, err := openRuntimeEndpointStore(path, runtimeAdapterRegistry())
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(restarted.configured(), store.configured()) {
		t.Fatalf("restart did not preserve runtime configuration: %#v", restarted.configured())
	}
}

func TestRuntimeEndpointValidationRejectsEveryNonLoopbackOrAmbiguousTarget(t *testing.T) {
	for _, endpoint := range []string{
		"https://127.0.0.1:8000", "http://localhost:8000", "http://0.0.0.0:8000",
		"http://192.168.1.10:8000", "http://127.0.0.1", "http://127.0.0.1:8000/v1",
		"http://user:secret@127.0.0.1:8000", "http://127.0.0.1:8000?token=secret",
	} {
		_, err := normalizeRuntimeEndpoints([]runtimeEndpoint{{
			AdapterID: "manual-openai-compatible", Endpoint: endpoint,
		}}, runtimeAdapterRegistry())
		if !errors.Is(err, errInvalidRuntimeEndpoints) {
			t.Fatalf("target %q must fail closed: %v", endpoint, err)
		}
	}
	for _, invalid := range []runtimeEndpoint{
		{AdapterID: "ollama", Endpoint: "http://127.0.0.1:11434"},
		{AdapterID: "unknown", Endpoint: "http://127.0.0.1:8000"},
		{AdapterID: "manual-openai-compatible", Endpoint: "http://127.0.0.1:8000", BearerToken: "token\nheader"},
	} {
		if _, err := normalizeRuntimeEndpoints([]runtimeEndpoint{invalid}, runtimeAdapterRegistry()); !errors.Is(err, errInvalidRuntimeEndpoints) {
			t.Fatalf("runtime input must fail closed: %#v err=%v", invalid, err)
		}
	}
}

func TestRuntimeEndpointRevisionPreservesOrExplicitlyClearsBearer(t *testing.T) {
	store := newMemoryRuntimeEndpointStore()
	token := "local-bearer"
	first, conflict, err := store.replaceInputs(1, []runtimeEndpointInput{{
		AdapterID: "manual-openai-compatible", Endpoint: "http://127.0.0.1:8000", BearerToken: &token,
	}}, runtimeAdapterRegistry())
	if err != nil || conflict {
		t.Fatalf("initial update failed: conflict=%v err=%v", conflict, err)
	}
	if _, conflict, err := store.replaceInputs(1, []runtimeEndpointInput{}, runtimeAdapterRegistry()); err != nil || !conflict {
		t.Fatalf("stale revision must conflict: conflict=%v err=%v", conflict, err)
	}
	second, conflict, err := store.replaceInputs(first.Revision, []runtimeEndpointInput{{
		AdapterID: "manual-openai-compatible", Endpoint: "http://127.0.0.1:8000",
	}}, runtimeAdapterRegistry())
	if err != nil || conflict || store.configured()[0].BearerToken != token {
		t.Fatalf("omitted bearer must preserve the existing secret: %#v conflict=%v err=%v", store.configured(), conflict, err)
	}
	empty := ""
	_, conflict, err = store.replaceInputs(second.Revision, []runtimeEndpointInput{{
		AdapterID: "manual-openai-compatible", Endpoint: "http://127.0.0.1:8000", BearerToken: &empty,
	}}, runtimeAdapterRegistry())
	if err != nil || conflict || store.configured()[0].BearerToken != "" {
		t.Fatalf("explicit empty bearer must clear the secret: %#v conflict=%v err=%v", store.configured(), conflict, err)
	}
}

func TestRuntimeEndpointControlSurfaceNeverReturnsBearer(t *testing.T) {
	core, err := url.Parse("http://127.0.0.1:1455")
	if err != nil {
		t.Fatal(err)
	}
	token := strings.Repeat("c", 32)
	store := newMemoryRuntimeEndpointStore()
	handler := providerHandlerWithStores(core, newMemorySelectionStore([]string{}), store, http.DefaultClient, token)

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/v1/runtime-endpoints", nil))
	if unauthorized.Code != http.StatusNotFound {
		t.Fatalf("unauthorized runtime endpoint leaked state: %d %s", unauthorized.Code, unauthorized.Body.String())
	}

	put := httptest.NewRequest(http.MethodPut, "/v1/runtime-endpoints", strings.NewReader(
		`{"revision":1,"endpoints":[{"adapter_id":"manual-openai-compatible","endpoint":"http://127.0.0.1:8000","bearer_token":"local-secret"}]}`,
	))
	put.Header.Set("authorization", "Bearer "+token)
	put.Header.Set("content-type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, put)
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), "local-secret") || strings.Contains(response.Body.String(), "bearer_token") {
		t.Fatalf("runtime response leaked the bearer: %d %s", response.Code, response.Body.String())
	}
}
