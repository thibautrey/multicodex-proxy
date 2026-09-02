package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func explicitBool(value bool) *bool { return &value }

func testCapacityPolicyState() capacityPolicyStateDocument {
	return capacityPolicyStateDocument{
		Paused:              explicitBool(false),
		AutomaticDownloads:  explicitBool(true),
		AllowCloudWorkloads: explicitBool(false),
		Policy:              testCapacityPolicyDocument(),
	}
}

func TestCapacityPolicyStoreRequiresExplicitConsentAndPersistsPrivately(t *testing.T) {
	path := filepath.Join(t.TempDir(), "capacity-policy.json")
	store, err := openCapacityPolicyStore(path)
	if err != nil {
		t.Fatal(err)
	}
	if store.snapshot() != nil {
		t.Fatal("an absent policy must remain unconfigured")
	}
	created, conflict, err := store.replace(0, testCapacityPolicyState())
	if err != nil || conflict || created == nil || created.Revision != 1 || created.SchemaVersion != capacityPolicyStateSchemaVersion {
		t.Fatalf("unexpected capacity policy creation: %#v conflict=%v err=%v", created, conflict, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("capacity policy permissions are unsafe: %#v %v", info, err)
	}
	restarted, err := openCapacityPolicyStore(path)
	if err != nil || restarted.snapshot() == nil || restarted.snapshot().Revision != 1 {
		t.Fatalf("capacity policy did not survive restart: %#v %v", restarted, err)
	}
}

func TestCapacityPolicyStoreRejectsOmissionsAndRevisionRaces(t *testing.T) {
	store := newMemoryCapacityPolicyStore()
	missing := testCapacityPolicyState()
	missing.AllowCloudWorkloads = nil
	if _, _, err := store.replace(0, missing); err == nil {
		t.Fatal("omitted Cloud consent was accepted")
	}
	created, conflict, err := store.replace(0, testCapacityPolicyState())
	if err != nil || conflict {
		t.Fatal(err)
	}
	stale := testCapacityPolicyState()
	stale.Paused = explicitBool(true)
	latest, conflict, err := store.replace(0, stale)
	if err != nil || !conflict || latest == nil || latest.Revision != created.Revision || *latest.Paused {
		t.Fatalf("stale writer was not fenced: %#v conflict=%v err=%v", latest, conflict, err)
	}
}

func TestCapacityPolicyStoreRejectsLoosePersistedJSON(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "capacity-policy.json")
	document := testCapacityPolicyState()
	document.SchemaVersion = capacityPolicyStateSchemaVersion
	document.Revision = 1
	raw, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(raw, []byte("\n{}\n")...), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := openCapacityPolicyStore(path); err == nil {
		t.Fatal("capacity policy store accepted trailing JSON")
	}
}

func TestCapacityPolicyControlAPIIsAuthenticatedAndRevisioned(t *testing.T) {
	core, _ := url.Parse("http://<MVSEC_IPV4_DAA4891F8A7E>:1455")
	store := newMemoryCapacityPolicyStore()
	token := strings.Repeat("c", 32)
	handler := providerHandlerWithAllServices(
		core, newMemorySelectionStore([]string{}), newMemoryRuntimeEndpointStore(), nil, nil, store,
		http.DefaultClient, token,
	)
	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/v1/capacity-policy", nil))
	if unauthorized.Code != http.StatusNotFound {
		t.Fatalf("unauthorized capacity policy leaked its route: %d", unauthorized.Code)
	}

	input := testCapacityPolicyState()
	input.SchemaVersion = capacityPolicyStateSchemaVersion
	input.Revision = 0
	body, _ := json.Marshal(input)
	request := httptest.NewRequest(http.MethodPut, "/v1/capacity-policy", strings.NewReader(string(body)))
	request.Header.Set("authorization", "Bearer "+token)
	request.Header.Set("content-type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("capacity policy creation failed: %d %s", response.Code, response.Body.String())
	}
	var created capacityPolicyStateDocument
	if json.Unmarshal(response.Body.Bytes(), &created) != nil || created.Revision != 1 || created.AllowCloudWorkloads == nil || *created.AllowCloudWorkloads {
		t.Fatalf("unexpected capacity policy response: %#v", created)
	}
}
