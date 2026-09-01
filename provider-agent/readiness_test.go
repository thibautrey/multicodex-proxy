package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

func TestReadinessUsesCredentialFreeCoreHealth(t *testing.T) {
	coreServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/health" {
			t.Fatalf("unexpected Core readiness request: %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("authorization") != "" {
			t.Fatal("provider agent readiness must not receive or send the proxy API key")
		}
		response.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(response).Encode(map[string]bool{"ok": true})
	}))
	t.Cleanup(coreServer.Close)
	core, err := url.Parse(coreServer.URL)
	if err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodGet, "/health/ready", nil)
	response := httptest.NewRecorder()
	providerHandler(core, []string{}, coreServer.Client()).ServeHTTP(response, request)

	if response.Code != http.StatusOK || response.Header().Get("content-type") != "application/json" {
		t.Fatalf("unexpected readiness response: %d %#v", response.Code, response.Header())
	}
}

func TestReadinessFailsClosedWhenCoreHealthFails(t *testing.T) {
	coreServer := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		http.Error(response, "unavailable", http.StatusServiceUnavailable)
	}))
	t.Cleanup(coreServer.Close)
	core, err := url.Parse(coreServer.URL)
	if err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodGet, "/health/ready", nil)
	response := httptest.NewRecorder()
	providerHandler(core, []string{}, coreServer.Client()).ServeHTTP(response, request)

	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected fail-closed readiness, got %d", response.Code)
	}
}
