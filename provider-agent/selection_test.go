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

func TestSelectionStorePersistsExactMode0600State(t *testing.T) {
	path := filepath.Join(t.TempDir(), "provider-selection.json")
	store, err := openSelectionStore(path, []string{"z-model", "org/model"})
	if err != nil {
		t.Fatal(err)
	}
	initial := store.snapshot()
	if initial.Revision != 1 || !reflect.DeepEqual(initial.SelectedModels, []string{"org/model", "z-model"}) {
		t.Fatalf("unexpected initial selection: %#v", initial)
	}
	updated, conflict, err := store.replace(1, []string{"publisher/model"})
	if err != nil || conflict || updated.Revision != 2 {
		t.Fatalf("unexpected update result: %#v %v %v", updated, conflict, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("selection state must be mode 0600, got %o", info.Mode().Perm())
	}
	restarted, err := openSelectionStore(path, []string{"ignored/initial"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(restarted.snapshot(), updated) {
		t.Fatalf("restart did not preserve selection: %#v", restarted.snapshot())
	}
	if _, conflict, err := restarted.replace(1, []string{}); err != nil || !conflict {
		t.Fatalf("stale revision must conflict without mutation: %v %v", conflict, err)
	}
}

func TestSelectionStoreRejectsUnsafeStateFiles(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "selection.json")
	if err := os.WriteFile(path, []byte(`{"schema_version":"provider-selection-v1","revision":1,"state":"detected","selected_models":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := openSelectionStore(path, []string{}); err == nil {
		t.Fatal("group-readable selection state must fail closed")
	}
	if err := os.Chmod(path, 0o400); err != nil {
		t.Fatal(err)
	}
	if _, err := openSelectionStore(path, []string{}); err == nil {
		t.Fatal("selection state must use exact mode 0600")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(directory, "missing"), path); err != nil {
		t.Fatal(err)
	}
	if _, err := openSelectionStore(path, []string{}); err == nil {
		t.Fatal("symlink selection state must fail closed")
	}
}

func TestSelectionStoreRejectsMalformedDocumentsAndSelections(t *testing.T) {
	for name, models := range map[string][]string{
		"nil":       nil,
		"duplicate": {"org/model", "org/model"},
		"url":       {"https://example.test/model"},
		"ip":        {"127.0.0.1/model"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := normalizeSelectedModels(models); !errors.Is(err, errInvalidSelectedModels) {
				t.Fatalf("unsafe selection must return the validation sentinel: %v", err)
			}
		})
	}

	path := filepath.Join(t.TempDir(), "selection.json")
	malformed := `{"schema_version":"provider-selection-v1","revision":1,"state":"detected","selected_models":[],"unexpected":true}`
	if err := os.WriteFile(path, []byte(malformed), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := openSelectionStore(path, []string{}); err == nil {
		t.Fatal("unknown persisted fields must fail closed")
	}
}

func TestSelectionStoreRollsBackMemoryWhenPersistenceFails(t *testing.T) {
	directory := filepath.Join(t.TempDir(), "state")
	path := filepath.Join(directory, "selection.json")
	store, err := openSelectionStore(path, []string{"initial/model"})
	if err != nil {
		t.Fatal(err)
	}
	before := store.snapshot()
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(directory); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(directory, []byte("not a directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, conflict, err := store.replace(before.Revision, []string{"new/model"}); err == nil || conflict {
		t.Fatalf("persistence failure must fail without a conflict: conflict=%v err=%v", conflict, err)
	}
	if after := store.snapshot(); !reflect.DeepEqual(after, before) {
		t.Fatalf("failed persistence mutated memory: before=%#v after=%#v", before, after)
	}
}

func TestSelectionEndpointsRequireLocalControlTokenAndRevision(t *testing.T) {
	core, err := url.Parse("http://127.0.0.1:1455")
	if err != nil {
		t.Fatal(err)
	}
	token := strings.Repeat("c", 32)
	store := newMemorySelectionStore([]string{})
	handler := providerHandlerWithSelection(core, store, http.DefaultClient, token)

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/v1/selection", nil))
	if unauthorized.Code != http.StatusNotFound || strings.Contains(unauthorized.Body.String(), token) {
		t.Fatalf("unauthorized selection endpoint leaked state: %d %q", unauthorized.Code, unauthorized.Body.String())
	}

	put := httptest.NewRequest(http.MethodPut, "/v1/selection", strings.NewReader(`{"revision":1,"selected_models":["publisher/model"]}`))
	put.Header.Set("authorization", "Bearer "+token)
	put.Header.Set("content-type", "application/json; charset=utf-8")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, put)
	if response.Code != http.StatusOK {
		t.Fatalf("unexpected selection update: %d %s", response.Code, response.Body.String())
	}
	var document selectionDocument
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatal(err)
	}
	if document.Revision != 2 || document.State != string(StateSelected) || !reflect.DeepEqual(document.SelectedModels, []string{"publisher/model"}) {
		t.Fatalf("unexpected selection document: %#v", document)
	}

	stale := httptest.NewRequest(http.MethodPut, "/v1/selection", strings.NewReader(`{"revision":1,"selected_models":[]}`))
	stale.Header.Set("authorization", "Bearer "+token)
	stale.Header.Set("content-type", "application/json")
	staleResponse := httptest.NewRecorder()
	handler.ServeHTTP(staleResponse, stale)
	if staleResponse.Code != http.StatusConflict || !strings.Contains(staleResponse.Body.String(), `"revision":2`) {
		t.Fatalf("stale selection update did not return current revision: %d %s", staleResponse.Code, staleResponse.Body.String())
	}

	invalid := httptest.NewRequest(http.MethodPut, "/v1/selection", strings.NewReader(`{"revision":2,"selected_models":["publisher/model","publisher/model"]}`))
	invalid.Header.Set("authorization", "Bearer "+token)
	invalid.Header.Set("content-type", "application/json")
	invalidResponse := httptest.NewRecorder()
	handler.ServeHTTP(invalidResponse, invalid)
	if invalidResponse.Code != http.StatusBadRequest || strings.Contains(invalidResponse.Body.String(), token) {
		t.Fatalf("invalid selection must fail closed without leaking control state: %d %s", invalidResponse.Code, invalidResponse.Body.String())
	}

	manifestResponse := httptest.NewRecorder()
	handler.ServeHTTP(manifestResponse, httptest.NewRequest(http.MethodGet, "/v1/manifest", nil))
	if !strings.Contains(manifestResponse.Body.String(), `"state":"selected"`) || strings.Contains(manifestResponse.Body.String(), token) {
		t.Fatalf("manifest did not reflect bounded selection: %s", manifestResponse.Body.String())
	}
}
