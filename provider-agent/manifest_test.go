package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"
)

func TestSelectedModelsAreUniqueBoundedAndDeterministic(t *testing.T) {
	t.Setenv("MULTIVIBE_PROVIDER_SELECTED_MODELS", `["ä-model","z-model","org/model"]`)
	models, err := selectedModels()
	if err != nil {
		t.Fatal(err)
	}
	expected := []string{"org/model", "z-model", "ä-model"}
	if !reflect.DeepEqual(models, expected) {
		t.Fatalf("unexpected deterministic order: %#v", models)
	}

	t.Setenv("MULTIVIBE_PROVIDER_SELECTED_MODELS", `["org/model","org/model"]`)
	if _, err := selectedModels(); err == nil {
		t.Fatal("duplicate selected model identifiers must fail closed")
	}

	tooMany := make([]string, 101)
	for index := range tooMany {
		tooMany[index] = "model-" + strings.Repeat("x", index%3) + string(rune(0x100+index))
	}
	encoded, err := json.Marshal(tooMany)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("MULTIVIBE_PROVIDER_SELECTED_MODELS", string(encoded))
	if _, err := selectedModels(); err == nil {
		t.Fatal("more than 100 selected models must fail closed")
	}
}

func TestSelectedModelsRejectURLsIPsAndPaths(t *testing.T) {
	invalid := []string{
		"https://models.example/model",
		"https:/models.example/model",
		"file:/etc/passwd",
		"org/https://models.example/model",
		"org/file:/etc/passwd",
		"127.0.0.1",
		"org/127.0.0.1",
		"2001:db8::1",
		"[2001:db8::1]",
		"/var/models/model",
		"C:/models/model",
		"org\\model",
		"org/\x00/model",
		"./model",
		"org/../model",
	}
	for _, model := range invalid {
		if validSelectedModelID(model) {
			t.Fatalf("expected %q to be rejected", model)
		}
	}
	if !validSelectedModelID("org/model") {
		t.Fatal("org/model must remain valid")
	}
}

func TestManifestStateReflectsExplicitSelection(t *testing.T) {
	core, err := url.Parse("http://127.0.0.1:1455")
	if err != nil {
		t.Fatal(err)
	}
	readManifest := func(models []string) manifest {
		request := httptest.NewRequest(http.MethodGet, "/v1/manifest", nil)
		response := httptest.NewRecorder()
		providerHandler(core, models, http.DefaultClient).ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("unexpected status %d", response.Code)
		}
		var document manifest
		if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
			t.Fatal(err)
		}
		return document
	}

	detected := readManifest([]string{})
	if detected.State != string(StateDetected) || detected.SelectedModels == nil || len(detected.SelectedModels) != 0 {
		t.Fatalf("unexpected detected manifest: %#v", detected)
	}
	selected := readManifest([]string{"org/model"})
	if selected.State != string(StateSelected) || !reflect.DeepEqual(selected.SelectedModels, []string{"org/model"}) {
		t.Fatalf("unexpected selected manifest: %#v", selected)
	}
}
