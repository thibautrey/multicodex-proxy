package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestDemandServicePlansOnlyAfterExplicitCloudConsentAndFencesReplay(t *testing.T) {
	raw, keys := demandInteropRaw(t)
	entry := providerModelCatalogEntry{
		CanonicalModelID: "hf:publisher/model", OllamaModel: "publisher:model", OllamaManifestPath: "registry.ollama.ai/library/publisher/model",
		ContentDigest:    "sha256:" + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		DownloadBytesHex: "0xee6b2800", GPUUtilization: 50,
		VRAMEstimates: []providerModelCatalogVRAM{{ContextTokens: 8192, EstimatedVRAMBytesHex: "0x12a05f200"}, {ContextTokens: 16384, EstimatedVRAMBytesHex: "0x165a0bc00"}},
		License: providerModelCatalogLicense{LicenseID: "Apache-2.0", HostedInferenceAllowed: true,
			AssessmentDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", AssessmentPath: "provider-model-license-assessments/test-model.md"},
	}
	catalog := providerModelCatalog{SchemaVersion: providerModelCatalogSchemaVersion, Models: []providerModelCatalogEntry{entry}}
	if err := validateProviderModelCatalog(&catalog); err != nil {
		t.Fatal(err)
	}
	policyStore := newMemoryCapacityPolicyStore()
	policyState := testCapacityPolicyState()
	policyState.AllowCloudWorkloads = explicitBool(true)
	created, conflict, err := policyStore.replace(0, policyState)
	if err != nil || conflict || created == nil {
		t.Fatal(err)
	}
	service, err := newProviderDemandService(keys, catalog, policyStore, newMemoryProviderDemandPlanStore(), hostCapability{Supported: true, GPUs: []nvidiaGPUCapability{{MemoryMiB: 16384}}})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2020, 1, 2, 12, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return now }
	service.sample = func(policy capacityPolicy, _ hostCapability, _ modelPlannerState) (hostCapacitySnapshot, error) {
		return hostCapacitySnapshot{ModelStoragePath: policy.modelStoragePath, TotalAcceleratorMemoryBytes: 16 * plannerGiB, FreeDiskBytes: 100 * plannerGiB}, nil
	}
	accepted, status, err := service.accept(raw)
	if err != nil || status != "accepted" || accepted == nil || len(accepted.Plan.SelectedModelIDs) != 1 {
		t.Fatalf("unexpected demand plan: %#v %q %v", accepted, status, err)
	}
	duplicate, status, err := service.accept(raw)
	if err != nil || status != "duplicate" || duplicate.EnvelopeDigest != accepted.EnvelopeDigest {
		t.Fatalf("exact replay was not deduplicated: %#v %q %v", duplicate, status, err)
	}
}

func TestDemandServiceRestoresOnlyReverifiedEnvelopeAndReplansLocally(t *testing.T) {
	raw, keys := demandInteropRaw(t)
	base := t.TempDir()
	path := filepath.Join(base, "demand-state.json")
	entry := providerModelCatalogEntry{
		CanonicalModelID: "hf:publisher/model", OllamaModel: "publisher:model", OllamaManifestPath: "registry.ollama.ai/library/publisher/model",
		ContentDigest: "sha256:" + strings.Repeat("a", 64), DownloadBytesHex: "0xee6b2800", GPUUtilization: 50,
		VRAMEstimates: []providerModelCatalogVRAM{{ContextTokens: 8192, EstimatedVRAMBytesHex: "0x12a05f200"}, {ContextTokens: 16384, EstimatedVRAMBytesHex: "0x165a0bc00"}},
		License: providerModelCatalogLicense{
			LicenseID: "Apache-2.0", HostedInferenceAllowed: true, AssessmentDigest: strings.Repeat("b", 64),
			AssessmentPath: "provider-model-license-assessments/test-model.md",
		},
	}
	catalog := providerModelCatalog{SchemaVersion: providerModelCatalogSchemaVersion, Models: []providerModelCatalogEntry{entry}}
	policyStore := newMemoryCapacityPolicyStore()
	policyState := testCapacityPolicyState()
	policyState.AllowCloudWorkloads = explicitBool(true)
	if _, _, err := policyStore.replace(0, policyState); err != nil {
		t.Fatal(err)
	}
	store, err := openProviderDemandPlanStore(path)
	if err != nil {
		t.Fatal(err)
	}
	service, err := newProviderDemandService(keys, catalog, policyStore, store, hostCapability{Supported: true, GPUs: []nvidiaGPUCapability{{MemoryMiB: 16384}}})
	if err != nil {
		t.Fatal(err)
	}
	issuedAt := time.Date(2020, 1, 2, 12, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return issuedAt }
	service.sample = func(policy capacityPolicy, _ hostCapability, _ modelPlannerState) (hostCapacitySnapshot, error) {
		return hostCapacitySnapshot{ModelStoragePath: policy.modelStoragePath, TotalAcceleratorMemoryBytes: 16 * plannerGiB, FreeDiskBytes: 100 * plannerGiB}, nil
	}
	accepted, _, err := service.accept(raw)
	if err != nil || len(accepted.Plan.SelectedModelIDs) != 1 {
		t.Fatalf("cannot persist signed demand envelope: %#v %v", accepted, err)
	}
	persisted, err := os.ReadFile(path)
	if err != nil || bytes.Contains(persisted, []byte(`"plan"`)) || !bytes.Contains(persisted, []byte(providerDemandEnvelopeStateSchemaVersion)) {
		t.Fatalf("persistence retained a trusted derived plan: %s %v", persisted, err)
	}

	reopened, err := openProviderDemandPlanStore(path)
	if err != nil || reopened.snapshot() != nil {
		t.Fatalf("persisted envelope was trusted before verification: %#v %v", reopened.snapshot(), err)
	}
	restored, err := newProviderDemandService(keys, catalog, policyStore, reopened, hostCapability{Supported: true, GPUs: []nvidiaGPUCapability{{MemoryMiB: 16384}}})
	if err != nil {
		t.Fatal(err)
	}
	restored.now = func() time.Time { return issuedAt.Add(30 * time.Second) }
	// A smaller current capacity proves that the old selected-model result is
	// not restored: the signed demand is re-planned against local state.
	restored.sample = func(policy capacityPolicy, _ hostCapability, _ modelPlannerState) (hostCapacitySnapshot, error) {
		return hostCapacitySnapshot{ModelStoragePath: policy.modelStoragePath, TotalAcceleratorMemoryBytes: plannerGiB, FreeDiskBytes: 100 * plannerGiB}, nil
	}
	if err := restored.restorePersisted(); err != nil {
		t.Fatal(err)
	}
	head := reopened.snapshot()
	if head == nil || head.EnvelopeDigest != accepted.EnvelopeDigest || len(head.Plan.SelectedModelIDs) != 0 {
		t.Fatalf("persisted signed demand was not locally recalculated: %#v", head)
	}

	expiredStore, err := openProviderDemandPlanStore(path)
	if err != nil {
		t.Fatal(err)
	}
	expired, err := newProviderDemandService(keys, catalog, policyStore, expiredStore, hostCapability{Supported: true, GPUs: []nvidiaGPUCapability{{MemoryMiB: 16384}}})
	if err != nil {
		t.Fatal(err)
	}
	expired.now = func() time.Time { return issuedAt.Add(2 * time.Minute) }
	if err := expired.restorePersisted(); !errors.Is(err, errInvalidProviderDemand) || expiredStore.snapshot() != nil {
		t.Fatalf("expired persisted envelope was restored: %#v %v", expiredStore.snapshot(), err)
	}
}

func TestDemandServiceManualPauseAlwaysWins(t *testing.T) {
	_, keys := demandInteropRaw(t)
	catalog := providerModelCatalog{SchemaVersion: providerModelCatalogSchemaVersion, Models: []providerModelCatalogEntry{{
		CanonicalModelID: "hf:publisher/model", OllamaModel: "publisher:model", OllamaManifestPath: "registry.ollama.ai/library/publisher/model",
		ContentDigest: "sha256:" + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", DownloadBytesHex: "0xee6b2800", GPUUtilization: 50,
		VRAMEstimates: []providerModelCatalogVRAM{{ContextTokens: 8192, EstimatedVRAMBytesHex: "0x12a05f200"}},
		License: providerModelCatalogLicense{LicenseID: "Apache-2.0", HostedInferenceAllowed: true,
			AssessmentDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", AssessmentPath: "provider-model-license-assessments/test-model.md"},
	}}}
	if err := validateProviderModelCatalog(&catalog); err != nil {
		t.Fatal(err)
	}
	policyStore := newMemoryCapacityPolicyStore()
	state := testCapacityPolicyState()
	state.Paused = explicitBool(true)
	state.AllowCloudWorkloads = explicitBool(true)
	if _, _, err := policyStore.replace(0, state); err != nil {
		t.Fatal(err)
	}
	service, err := newProviderDemandService(keys, catalog, policyStore, newMemoryProviderDemandPlanStore(), hostCapability{Supported: true, GPUs: []nvidiaGPUCapability{{MemoryMiB: 8192}}})
	if err != nil {
		t.Fatal(err)
	}
	service.now = func() time.Time { return time.Date(2020, 1, 2, 12, 0, 0, 0, time.UTC) }
	raw, _ := demandInteropRaw(t)
	if _, _, err := service.accept(raw); !errors.Is(err, errProviderCapacityNotAuthorized) {
		t.Fatalf("manual pause did not win: %v", err)
	}
}

func TestProviderCapacityUsesOnlyPinnedGPUVRAMWithoutSharding(t *testing.T) {
	policy := testCapacityPolicy(t)
	policy.modelStoragePath = t.TempDir()
	capability := hostCapability{
		Supported:    true,
		Profile:      "linux-nvidia",
		OS:           "linux",
		Architecture: "amd64",
		Accelerator:  "cuda",
		GPUs: []nvidiaGPUCapability{
			{Name: "GPU 0", MemoryMiB: 8192, ComputeCapability: 8.6},
			{Name: "GPU 1", MemoryMiB: 8192, ComputeCapability: 8.6},
		},
	}
	capability, err := selectNVIDIACUDADevice(capability, "")
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := defaultProviderCapacitySnapshot(policy, capability, modelPlannerState{})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.TotalAcceleratorMemoryBytes != 8*plannerGiB {
		t.Fatalf("two unsharded 8 GiB GPUs were aggregated: got %d bytes", snapshot.TotalAcceleratorMemoryBytes)
	}

	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	modelID := "publisher/per-device-too-large"
	plan, err := planModels(
		policy,
		snapshot,
		[]modelCandidate{{
			ModelID: modelID, GPUUtilizationPercent: 50, GPUVRAMBytes: 7 * plannerGiB,
			ArtifactBytes: plannerGiB, MaxContextTokens: 8192,
		}},
		testDemand(now, authoritativeModelDemand{ModelID: modelID, DemandUnits: 1, RequiredContextTokens: 8192}),
		modelPlannerState{},
		now,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.SelectedModelIDs) != 0 || !hasPlanConstraint(plan, modelID, "gpu-vram-budget") {
		t.Fatalf("model larger than each physical GPU became admissible: %#v", plan)
	}
}

func TestProviderCapacityUsesConfiguredGPUWithoutAggregation(t *testing.T) {
	policy := testCapacityPolicy(t)
	policy.modelStoragePath = t.TempDir()
	capability, err := selectNVIDIACUDADevice(hostCapability{
		Supported:    true,
		Profile:      "linux-nvidia",
		OS:           "linux",
		Architecture: "amd64",
		Accelerator:  "cuda",
		GPUs: []nvidiaGPUCapability{
			{Name: "GPU 0", MemoryMiB: 6144, ComputeCapability: 8.6},
			{Name: "GPU 1", MemoryMiB: 10240, ComputeCapability: 8.9},
		},
	}, "1")
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := defaultProviderCapacitySnapshot(policy, capability, modelPlannerState{})
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.TotalAcceleratorMemoryBytes != 10*plannerGiB {
		t.Fatalf("capacity was not bound to configured GPU 1: got %d bytes", snapshot.TotalAcceleratorMemoryBytes)
	}
}

func TestProviderCapacityRejectsMissingOrOutOfRangePinnedGPU(t *testing.T) {
	policy := testCapacityPolicy(t)
	policy.modelStoragePath = t.TempDir()
	for name, capability := range map[string]hostCapability{
		"missing inventory": {Supported: true, Accelerator: "cuda", AcceleratorMemoryBytes: 8 * plannerGiB},
		"out of range pin": {
			Supported: true, Accelerator: "cuda", CUDADevice: 1, AcceleratorMemoryBytes: 8 * plannerGiB,
			GPUs: []nvidiaGPUCapability{{Name: "GPU 0", MemoryMiB: 8192, ComputeCapability: 8.6}},
		},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := defaultProviderCapacitySnapshot(policy, capability, modelPlannerState{}); err == nil {
				t.Fatal("unavailable pinned GPU capacity was accepted")
			}
		})
	}
}

func TestDemandServicePlansAgainstConservativeAppleUnifiedMemory(t *testing.T) {
	raw, keys := demandInteropRaw(t)
	entry := providerModelCatalogEntry{
		CanonicalModelID: "hf:publisher/model", OllamaModel: "publisher:model", OllamaManifestPath: "registry.ollama.ai/library/publisher/model",
		ContentDigest: "sha256:" + strings.Repeat("a", 64), DownloadBytesHex: "0xee6b2800", GPUUtilization: 50,
		VRAMEstimates: []providerModelCatalogVRAM{{ContextTokens: 8192, EstimatedVRAMBytesHex: "0x12a05f200"}, {ContextTokens: 16384, EstimatedVRAMBytesHex: "0x165a0bc00"}},
		License: providerModelCatalogLicense{
			LicenseID: "Apache-2.0", HostedInferenceAllowed: true, AssessmentDigest: strings.Repeat("b", 64),
			AssessmentPath: "provider-model-license-assessments/test-model.md",
		},
	}
	catalog := providerModelCatalog{SchemaVersion: providerModelCatalogSchemaVersion, Models: []providerModelCatalogEntry{entry}}
	for _, testCase := range []struct {
		name                    string
		sysctlOutput            string
		wantAcceleratorCapacity uint64
		wantSelected            bool
	}{
		{name: "16 GiB admits within capped budget", sysctlOutput: "17179869184\n", wantAcceleratorCapacity: 8 * plannerGiB, wantSelected: true},
		{name: "8 GiB rejects beyond capped budget", sysctlOutput: "8589934592\n", wantAcceleratorCapacity: 4 * plannerGiB, wantSelected: false},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			capability := detectHostCapability(context.Background(), "darwin", "arm64", func(context.Context, string, ...string) ([]byte, error) {
				return []byte(testCase.sysctlOutput), nil
			})
			if !capability.Supported || capability.AcceleratorMemoryBytes != testCase.wantAcceleratorCapacity {
				t.Fatalf("unexpected Apple accelerator capacity: %#v", capability)
			}
			policyStore := newMemoryCapacityPolicyStore()
			policyState := testCapacityPolicyState()
			policyState.AllowCloudWorkloads = explicitBool(true)
			policyState.Policy.ModelStoragePath = t.TempDir()
			policyState.Policy.ReserveFreeDiskBytes = plannerPointer(uint64(1))
			if _, _, err := policyStore.replace(0, policyState); err != nil {
				t.Fatal(err)
			}
			service, err := newProviderDemandService(keys, catalog, policyStore, newMemoryProviderDemandPlanStore(), capability)
			if err != nil {
				t.Fatal(err)
			}
			service.now = func() time.Time { return time.Date(2020, 1, 2, 12, 0, 0, 0, time.UTC) }
			service.state = func() (modelPlannerState, error) {
				return modelPlannerState{
					InstalledModelIDs: []string{entry.CanonicalModelID}, ActiveModels: []activeModelState{},
					ModelChanges: []time.Time{}, Downloads: []modelDownloadHistoryEntry{},
				}, nil
			}
			accepted, status, err := service.accept(raw)
			if err != nil || status != "accepted" || accepted == nil {
				t.Fatalf("Apple signed demand planning failed: %#v %q %v", accepted, status, err)
			}
			selected := len(accepted.Plan.SelectedModelIDs) == 1
			if selected != testCase.wantSelected {
				t.Fatalf("unexpected Apple plan under conservative capacity: %#v", accepted.Plan)
			}
			if !testCase.wantSelected && !hasPlanConstraint(accepted.Plan, entry.CanonicalModelID, "gpu-vram-budget") {
				t.Fatalf("missing accelerator-memory exclusion: %#v", accepted.Plan.Constraints)
			}
		})
	}
}

func TestDecodeProviderDemandRequestRejectsBlankAndOversizedBodies(t *testing.T) {
	for name, body := range map[string][]byte{
		"empty":      {},
		"whitespace": []byte(" \n\t\r"),
		"oversized":  bytes.Repeat([]byte{'x'}, maximumProviderDemandBytes+1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeProviderDemandRequest(bytes.NewReader(body)); !errors.Is(err, errInvalidProviderDemand) {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}

	valid := []byte(`{"kind":"provider_demand_snapshot"}`)
	decoded, err := decodeProviderDemandRequest(bytes.NewReader(valid))
	if err != nil || !bytes.Equal(decoded, valid) {
		t.Fatalf("valid bounded request was not preserved: %q %v", decoded, err)
	}
}

func TestManagedCatalogDiskBytesFailsClosedOnUnknownOrDuplicateInventory(t *testing.T) {
	catalog := providerModelCatalog{Models: []providerModelCatalogEntry{{CanonicalModelID: "hf:publisher/model", DownloadBytes: 42}}}
	if total, err := managedCatalogDiskBytes(catalog, []string{"hf:publisher/model"}); err != nil || total != 42 {
		t.Fatalf("unexpected managed catalog accounting: %d %v", total, err)
	}
	for _, installed := range [][]string{{"hf:publisher/unknown"}, {"hf:publisher/model", "hf:publisher/model"}} {
		if _, err := managedCatalogDiskBytes(catalog, installed); !errors.Is(err, errInvalidModelPlannerInput) {
			t.Fatalf("unsafe managed inventory was accepted: %#v %v", installed, err)
		}
	}
}

func TestDemandServiceControlAPIAuthenticatesPlansAndDeduplicates(t *testing.T) {
	raw, keys := demandInteropRaw(t)
	entry := providerModelCatalogEntry{
		CanonicalModelID: "hf:publisher/model", OllamaModel: "publisher:model", OllamaManifestPath: "registry.ollama.ai/library/publisher/model",
		ContentDigest: "sha256:" + strings.Repeat("a", 64), DownloadBytesHex: "0xee6b2800", GPUUtilization: 50,
		VRAMEstimates: []providerModelCatalogVRAM{{ContextTokens: 8192, EstimatedVRAMBytesHex: "0x12a05f200"}, {ContextTokens: 16384, EstimatedVRAMBytesHex: "0x165a0bc00"}},
		License: providerModelCatalogLicense{LicenseID: "Apache-2.0", HostedInferenceAllowed: true,
			AssessmentDigest: strings.Repeat("b", 64), AssessmentPath: "provider-model-license-assessments/test-model.md"},
	}
	catalog := providerModelCatalog{SchemaVersion: providerModelCatalogSchemaVersion, Models: []providerModelCatalogEntry{entry}}
	if err := validateProviderModelCatalog(&catalog); err != nil {
		t.Fatal(err)
	}
	policyStore := newMemoryCapacityPolicyStore()
	policyState := testCapacityPolicyState()
	policyState.AllowCloudWorkloads = explicitBool(true)
	if _, _, err := policyStore.replace(0, policyState); err != nil {
		t.Fatal(err)
	}
	service, err := newProviderDemandService(keys, catalog, policyStore, newMemoryProviderDemandPlanStore(), hostCapability{Supported: true, GPUs: []nvidiaGPUCapability{{MemoryMiB: 16384}}})
	if err != nil {
		t.Fatal(err)
	}
	service.now = func() time.Time { return time.Date(2020, 1, 2, 12, 0, 0, 0, time.UTC) }
	service.sample = func(policy capacityPolicy, _ hostCapability, _ modelPlannerState) (hostCapacitySnapshot, error) {
		return hostCapacitySnapshot{ModelStoragePath: policy.modelStoragePath, TotalAcceleratorMemoryBytes: 16 * plannerGiB, FreeDiskBytes: 100 * plannerGiB}, nil
	}
	core, _ := url.Parse("http://<MVSEC_IPV4_DAA4891F8A7E>:1455")
	token := strings.Repeat("d", 32)
	handler := providerHandlerWithDemandService(core, newMemorySelectionStore([]string{}), newMemoryRuntimeEndpointStore(), nil, nil, policyStore, service, http.DefaultClient, token)

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodPost, "/v1/cloud-shadow/demand", bytes.NewReader(raw)))
	if unauthorized.Code != http.StatusNotFound {
		t.Fatalf("unauthorized demand route leaked: %d", unauthorized.Code)
	}

	submit := func() *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/v1/cloud-shadow/demand", bytes.NewReader(raw))
		request.Header.Set("authorization", "Bearer "+token)
		request.Header.Set("content-type", "application/json")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	if response := submit(); response.Code != http.StatusCreated {
		t.Fatalf("signed demand was not accepted: %d %s", response.Code, response.Body.String())
	}
	if response := submit(); response.Code != http.StatusOK {
		t.Fatalf("exact demand replay was not deduplicated: %d %s", response.Code, response.Body.String())
	}

	request := httptest.NewRequest(http.MethodGet, "/v1/cloud-shadow/demand-plan", nil)
	request.Header.Set("authorization", "Bearer "+token)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	var plan providerDemandPlanState
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &plan) != nil || plan.Generation != 1 {
		t.Fatalf("accepted plan was not readable: %d %s", response.Code, response.Body.String())
	}
}
