package runtimeprofile

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestRuntimeSchemasUseDraft202012AndCloseEveryObject(t *testing.T) {
	schemaDirectory := filepath.Join("..", "..", "packaging", "schemas")
	for _, name := range []string{
		"provider-runtime-profiles.schema.json",
		"provider-runtime-profile-overrides.schema.json",
		"provider-runtime-benchmark-spec.schema.json",
		"provider-runtime-benchmark-result.schema.json",
		"provider-runtime-benchmark-store.schema.json",
	} {
		t.Run(name, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join(schemaDirectory, name))
			if err != nil {
				t.Fatal(err)
			}
			var schema map[string]any
			if json.Unmarshal(raw, &schema) != nil || schema["$schema"] != "https://json-schema.org/draft/2020-12/schema" {
				t.Fatal("schema is not valid Draft 2020-12 metadata")
			}
			assertClosedSchemaObjects(t, schema, "$")
		})
	}
}

func assertClosedSchemaObjects(t *testing.T, value any, path string) {
	t.Helper()
	switch typed := value.(type) {
	case map[string]any:
		if typed["type"] == "object" && typed["additionalProperties"] != false {
			t.Fatalf("schema object is open at %s", path)
		}
		for key, child := range typed {
			assertClosedSchemaObjects(t, child, path+"/"+key)
		}
	case []any:
		for index, child := range typed {
			assertClosedSchemaObjects(t, child, fmt.Sprintf("%s/%d", path, index))
		}
	}
}

func TestOverrideExampleMatchesGoldenAndStrictDecoder(t *testing.T) {
	example, err := os.ReadFile(filepath.Join("..", "..", "packaging", "examples", "runtime-profile-overrides.json"))
	if err != nil {
		t.Fatal(err)
	}
	golden, err := os.ReadFile(filepath.Join("testdata", "overrides-v1.golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(example, golden) {
		t.Fatal("override example drifted from reviewed golden")
	}
	if _, err := DecodeOverrides(example); err != nil {
		t.Fatal(err)
	}
	unknown := append(example[:len(example)-2], []byte(",\n  \"command\": \"sh\"\n}\n")...)
	if _, err := DecodeOverrides(unknown); err == nil {
		t.Fatal("executable override field was accepted")
	}
}
