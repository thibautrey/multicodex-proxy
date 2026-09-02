package runtimebackend

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestLaunchPolicyCannotBeSerialized(t *testing.T) {
	policy := launchPolicy{
		executableRelativePaths: map[string]string{"linux-amd64": "bin/runtime"},
		argumentTemplates:       [][]string{{"serve"}},
		environmentAllowlist:    []string{"CUDA_VISIBLE_DEVICES"},
		deviceBindings:          []string{"private-device"},
	}
	if _, err := json.Marshal(policy); !errors.Is(err, ErrInvalid) {
		t.Fatalf("launch policy serialization did not fail closed: %v", err)
	}
}
