package runtimebenchmark_test

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/thibautrey/multivibe/provider-agent/runtimebenchmark"
)

const (
	checkedInResultFileSHA256 = "86ab35d0f56be296e3a15a5a65af8785e266ffe5acf2e9b48bebfb34da2e12b6"
	checkedInResultDigest     = "sha256:78e227e02be3803afbdf2b185fbe88595bbdf8902fa53852a810705961c31acb"
)

func TestCheckedInRuntimeCommunityResultPassesStrictStoreValidation(t *testing.T) {
	resultPath := filepath.Join("..", "..", "docs", "runtime-community-gpu-benchmark-e690aa1.result.json")
	resultRaw, err := os.ReadFile(resultPath)
	if err != nil {
		t.Fatal(err)
	}
	if actual := fmt.Sprintf("%x", sha256.Sum256(resultRaw)); actual != checkedInResultFileSHA256 {
		t.Fatalf("checked-in result file digest mismatch: %s", actual)
	}

	storePath := filepath.Join(t.TempDir(), "runtime-benchmarks.json")
	storeRaw := append([]byte(`{"schema_version":"provider-runtime-benchmark-store-v1","results":[`), resultRaw...)
	storeRaw = append(storeRaw, []byte(`]}`)...)
	if err := os.WriteFile(storePath, storeRaw, 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := runtimebenchmark.NewStore(storePath, runtimebenchmark.StoreOptions{MaximumResults: 1})
	if err != nil {
		t.Fatal(err)
	}
	document, err := store.Read()
	if err != nil {
		t.Fatalf("checked-in result failed strict runtime validation: %v", err)
	}
	if len(document.Results) != 1 || document.Results[0].ResultDigest != checkedInResultDigest {
		t.Fatalf("unexpected checked-in result identity: %#v", document.Results)
	}
}
