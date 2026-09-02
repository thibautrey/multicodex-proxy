package main

import (
	"errors"
	"testing"

	"github.com/thibautrey/multivibe/provider-agent/runtimebenchmark"
)

func TestCLIRequiresExplicitRunAndHasNoPromptFlag(t *testing.T) {
	if err := run(nil); !errors.Is(err, runtimebenchmark.ErrDisabled) {
		t.Fatalf("CLI did not require --run: %v", err)
	}
	if err := run([]string{"--prompt", "private", "--run"}); !errors.Is(err, runtimebenchmark.ErrInvalid) {
		t.Fatalf("CLI accepted a free prompt flag: %v", err)
	}
	if err := run([]string{"--ollama-model", "attacker:latest", "--run"}); !errors.Is(err, runtimebenchmark.ErrInvalid) {
		t.Fatalf("CLI accepted an unreviewed Ollama model flag: %v", err)
	}
}
