package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestCapabilityEndpointRequiresLocalControlAuthorization(t *testing.T) {
	core, err := url.Parse("http://127.0.0.1:1455")
	if err != nil {
		t.Fatal(err)
	}
	token := strings.Repeat("c", 32)
	capability := hostCapability{
		SchemaVersion:          "multivibe-host-capability-v1",
		AgentVersion:           "test",
		Supported:              true,
		Profile:                "apple-silicon",
		OS:                     "darwin",
		Architecture:           "arm64",
		Accelerator:            "metal",
		HardwareModel:          "Apple M4 Max",
		AcceleratorMemoryBytes: 32 * 1024 * 1024 * 1024,
	}
	handler := providerHandlerWithManagedControllerAndCapability(
		core,
		newMemorySelectionStore([]string{}),
		newMemoryRuntimeEndpointStore(),
		nil, nil, nil, nil, nil,
		capability,
		http.DefaultClient,
		token,
	)

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/v1/capability", nil))
	if unauthorized.Code != http.StatusNotFound || strings.Contains(unauthorized.Body.String(), "Apple") {
		t.Fatalf("unauthorized capability leaked state: %d %q", unauthorized.Code, unauthorized.Body.String())
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/capability", nil)
	request.Header.Set("authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("cache-control") != "no-store" {
		t.Fatalf("unexpected capability response: %d %q", response.Code, response.Body.String())
	}
	var actual hostCapability
	if err := json.Unmarshal(response.Body.Bytes(), &actual); err != nil {
		t.Fatal(err)
	}
	if actual.HardwareModel != capability.HardwareModel || actual.AcceleratorMemoryBytes != capability.AcceleratorMemoryBytes {
		t.Fatalf("unexpected capability: %#v", actual)
	}
}
