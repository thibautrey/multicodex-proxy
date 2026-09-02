package runtimebenchmark

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/thibautrey/multivibe/provider-agent/runtimebackend"
)

const benchmarkGiB uint64 = 1 << 30

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (clock *fakeClock) Now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	return clock.now
}

func (clock *fakeClock) advance(duration time.Duration) {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	clock.now = clock.now.Add(duration)
}

type fakeHarness struct {
	mu           sync.Mutex
	clock        *fakeClock
	backendID    string
	memory       uint64
	baseline     uint64
	runCalls     int
	failures     map[int]error
	protocolAt   map[int]bool
	omitPrefill  bool
	requests     []SyntheticRequest
	loaded       bool
	memoryCalls  uint32
	nativeTiming bool
}

func (fake *fakeHarness) BackendID() string { return fake.backendID }

func (fake *fakeHarness) Load(_ context.Context, workload SyntheticWorkload) error {
	if workload.RuntimeID != fake.backendID {
		return ErrInvalid
	}
	fake.clock.advance(250 * time.Millisecond)
	fake.mu.Lock()
	fake.loaded = true
	fake.memory = 2 * benchmarkGiB
	fake.mu.Unlock()
	return nil
}

func (fake *fakeHarness) RunSynthetic(_ context.Context, request SyntheticRequest, emit func(Event) error) (RunSummary, error) {
	fake.mu.Lock()
	call := fake.runCalls
	fake.runCalls++
	fake.requests = append(fake.requests, request)
	failure := fake.failures[call]
	protocol := fake.protocolAt[call]
	loaded := fake.loaded
	fake.mu.Unlock()
	if !loaded {
		return RunSummary{}, runtimebackend.ErrCrashed
	}
	if failure != nil {
		fake.clock.advance(10 * time.Millisecond)
		return RunSummary{}, failure
	}
	if protocol {
		if err := emit(Event{Kind: EventFinal}); err != nil {
			return RunSummary{}, err
		}
		return RunSummary{}, nil
	}
	fake.clock.advance(20 * time.Millisecond)
	fake.mu.Lock()
	fake.memory = 3 * benchmarkGiB
	fake.mu.Unlock()
	if !fake.omitPrefill {
		if err := emit(Event{Kind: EventPrefillComplete}); err != nil {
			return RunSummary{}, err
		}
	}
	for token := uint32(0); token < request.MaximumTokens; token++ {
		fake.clock.advance(5 * time.Millisecond)
		if err := emit(Event{Kind: EventToken, TokenCount: 1}); err != nil {
			return RunSummary{}, err
		}
	}
	fake.clock.advance(time.Millisecond)
	if err := emit(Event{Kind: EventFinal}); err != nil {
		return RunSummary{}, err
	}
	summary := RunSummary{
		PromptTokens: 48, OutputTokens: request.MaximumTokens,
		SampledPeakMemoryBytes: 3 * benchmarkGiB, MemorySamples: 4,
		ObservedRuntimeContextTokens: request.RequestedRuntime.ContextTokens,
	}
	if fake.nativeTiming {
		summary.PromptEvalNanoseconds = uint64(15 * time.Millisecond)
		summary.EvalNanoseconds = uint64(20 * time.Millisecond)
		summary.TotalNanoseconds = uint64(50 * time.Millisecond)
		summary.NativeTiming = true
	}
	return summary, nil
}

func (fake *fakeHarness) MemoryBytes(context.Context) (uint64, error) {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.memoryCalls++
	return fake.memory, nil
}

func (fake *fakeHarness) Unload(_ context.Context, _ SyntheticWorkload) error {
	fake.clock.advance(10 * time.Millisecond)
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.loaded = false
	fake.memory = fake.baseline
	return nil
}

func newFakeHarness(clock *fakeClock) *fakeHarness {
	return &fakeHarness{
		clock: clock, backendID: "ollama-managed", memory: benchmarkGiB, baseline: benchmarkGiB,
		failures: map[int]error{}, protocolAt: map[int]bool{},
	}
}

func benchmarkDigest(character string) string {
	return "sha256:" + strings.Repeat(character, 64)
}

func validSpec() Spec {
	return Spec{
		SchemaVersion: SpecVersion, Enabled: true, BenchmarkID: "bench-001", ProfileID: "qwen-ollama",
		ProfileDigest: benchmarkDigest("a"), CatalogDigest: benchmarkDigest("b"),
		ModelID: "hf:qwen/qwen2.5-0.5b-instruct", ModelContentDigest: benchmarkDigest("c"),
		HardwareClass: "nvidia-cuda-8gb", RuntimeID: "ollama-managed", Dataset: SyntheticDataset,
		Runs: 3, WarmupRuns: 1, SyntheticTerms: 32, MaximumOutputTokens: 8,
		RequestedRuntime: RuntimeSettings{ContextTokens: 8192, BatchSize: 128, Parallelism: 1, GPUOffloadLayers: 24},
		Seed:             ReproducibleSeed,
		TemperatureMilli: ReproducibleTemperature, RunTimeoutMilliseconds: 1000,
	}
}

func runSuccessfulBenchmark(t *testing.T) (Result, *fakeHarness) {
	t.Helper()
	clock := &fakeClock{now: time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)}
	harness := newFakeHarness(clock)
	result, err := NewRunner(Options{Now: clock.Now}).Run(context.Background(), harness, validSpec())
	if err != nil {
		t.Fatal(err)
	}
	return result, harness
}

func TestRunnerMeasuresColdLoadWarmRunsLatencyThroughputMemoryAndStability(t *testing.T) {
	result, harness := runSuccessfulBenchmark(t)
	if !result.Passed || result.SuccessfulRuns != 3 || result.StabilityBasisPoints != 10_000 {
		t.Fatalf("benchmark did not pass: %#v", result)
	}
	if result.WarmupRuns != 1 || result.SyntheticTerms != 32 || result.MaximumOutputTokens != 8 ||
		result.RequestedRuntime != validSpec().RequestedRuntime || result.RunTimeoutMilliseconds != 1000 {
		t.Fatalf("result omitted benchmark-defining parameters: %#v", result)
	}
	if result.LoadMilliseconds.P50 != 250 || result.PrefillMilliseconds.P50 != 20 ||
		result.TimeToFirstTokenMillis.P50 != 25 || result.EndToEndMilliseconds.P50 != 61 ||
		result.TokensPerSecondMilli.P50 != 200_000 {
		t.Fatalf("unexpected latency/throughput metrics: %#v", result)
	}
	if result.PrefillMeasurement != PrefillObserved || result.GenerationTimingMeasurement != TimingEventClock ||
		result.ObservedPromptTokens.P50 != 48 || result.ObservedOutputTokens.P50 != 8 ||
		result.ObservedRuntimeContext.P50 != 8192 || result.Memory.BaselineBytes != benchmarkGiB ||
		result.Memory.SampledPeakBytes.P95 != 3*benchmarkGiB || result.Memory.SamplesPerRun.P50 != 4 ||
		result.Memory.RecoveryBytes != benchmarkGiB || result.Memory.Measurement != MemorySampledDuringRun ||
		result.HardwareClassMeasurement != HardwareProfileDeclared || result.PassScope != BenchmarkPassScope ||
		result.ProfileCompatibilityAttested {
		t.Fatalf("unexpected prefill/memory metrics: %#v", result)
	}
	if harness.runCalls != 4 || len(harness.requests) != 4 {
		t.Fatalf("cold/warm run count mismatch: %d", harness.runCalls)
	}
	firstTerms := harness.requests[0].TermIDs
	for _, request := range harness.requests {
		if request.Seed != ReproducibleSeed || request.TemperatureMilli != 0 || request.Dataset != SyntheticDataset ||
			request.RequestedRuntime != validSpec().RequestedRuntime || !reflect.DeepEqual(firstTerms, request.TermIDs) {
			t.Fatalf("synthetic input is not reproducible: %#v", request)
		}
	}
	if digest, err := ResultDigest(result); err != nil || digest != result.ResultDigest {
		t.Fatalf("result digest mismatch: %q %v", digest, err)
	}
	tampered := result
	tampered.MaximumOutputTokens++
	if validateResult(tampered) == nil {
		t.Fatal("result parameter tampering did not invalidate the digest")
	}
	falseAttestation := result
	falseAttestation.ProfileCompatibilityAttested = true
	falseAttestation.ResultDigest = ""
	attestationDigest, err := ResultDigest(falseAttestation)
	if err != nil {
		t.Fatal(err)
	}
	falseAttestation.ResultDigest = attestationDigest
	if validateResult(falseAttestation) == nil {
		t.Fatal("diagnostic benchmark was allowed to claim profile compatibility")
	}
}

func TestRunnerUsesNativeCountsAndDurationsWithoutSamplingInEventCallback(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)}
	harness := newFakeHarness(clock)
	harness.nativeTiming = true
	result, err := NewRunner(Options{Now: clock.Now}).Run(context.Background(), harness, validSpec())
	if err != nil {
		t.Fatal(err)
	}
	if result.PrefillMeasurement != PrefillBackendNative || result.GenerationTimingMeasurement != TimingBackendNative ||
		result.PrefillMilliseconds.P50 != 15 || result.EndToEndMilliseconds.P50 != 50 ||
		result.TokensPerSecondMilli.P50 != 400_000 || harness.memoryCalls != 2 {
		t.Fatalf("native timing or memory-call isolation mismatch: %#v calls=%d", result, harness.memoryCalls)
	}
}

func TestRunnerMarksTTFTFallbackWhenPrefillObservationIsUnavailable(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)}
	harness := newFakeHarness(clock)
	harness.omitPrefill = true
	spec := validSpec()
	spec.WarmupRuns = 0
	result, err := NewRunner(Options{Now: clock.Now}).Run(context.Background(), harness, spec)
	if err != nil {
		t.Fatal(err)
	}
	if !result.Passed || result.PrefillMeasurement != PrefillTTFTFallback ||
		result.PrefillMilliseconds.P50 != result.TimeToFirstTokenMillis.P50 {
		t.Fatalf("prefill fallback is not explicit: %#v", result)
	}
}

func TestRunnerClassifiesStableFailureKinds(t *testing.T) {
	tests := []struct {
		name  string
		err   error
		count func(FailureCounts) uint32
	}{
		{name: "oom", err: runtimebackend.ErrOutOfMemory, count: func(value FailureCounts) uint32 { return value.OutOfMemory }},
		{name: "crash", err: runtimebackend.ErrCrashed, count: func(value FailureCounts) uint32 { return value.Crash }},
		{name: "timeout", err: runtimebackend.ErrTimedOut, count: func(value FailureCounts) uint32 { return value.Timeout }},
		{name: "cancel", err: runtimebackend.ErrCancelled, count: func(value FailureCounts) uint32 { return value.Cancelled }},
		{name: "unknown", err: errors.New("adapter detail that must not be persisted"), count: func(value FailureCounts) uint32 { return value.Unknown }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			clock := &fakeClock{now: time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)}
			harness := newFakeHarness(clock)
			harness.failures[0] = test.err
			spec := validSpec()
			spec.WarmupRuns = 0
			result, err := NewRunner(Options{Now: clock.Now}).Run(context.Background(), harness, spec)
			if err != nil {
				t.Fatal(err)
			}
			if result.Passed || result.SuccessfulRuns != 2 || result.StabilityBasisPoints != 6666 || test.count(result.Failures) != 1 {
				t.Fatalf("failure was not normalized: %#v", result)
			}
			raw := result.ResultDigest
			if strings.Contains(raw, "adapter detail") {
				t.Fatal("raw backend error leaked into report")
			}
		})
	}
}

func TestRunnerClassifiesProtocolViolations(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)}
	harness := newFakeHarness(clock)
	harness.protocolAt[0] = true
	spec := validSpec()
	spec.WarmupRuns = 0
	result, err := NewRunner(Options{Now: clock.Now}).Run(context.Background(), harness, spec)
	if err != nil {
		t.Fatal(err)
	}
	if result.Failures.Protocol != 1 || result.Passed {
		t.Fatalf("protocol violation was not recorded: %#v", result)
	}
}

func TestBenchmarkIsOptInAndRealOOMProbeNeedsSecondExplicitGate(t *testing.T) {
	clock := &fakeClock{now: time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)}
	harness := newFakeHarness(clock)
	spec := validSpec()
	spec.Enabled = false
	if _, err := NewRunner(Options{Now: clock.Now}).Run(context.Background(), harness, spec); !errors.Is(err, ErrDisabled) {
		t.Fatalf("disabled benchmark was accepted: %v", err)
	}
	spec.Enabled = true
	spec.InduceOOM = true
	if _, err := NewRunner(Options{Now: clock.Now}).Run(context.Background(), harness, spec); !errors.Is(err, ErrDestructiveDisabled) {
		t.Fatalf("OOM probe ran without second gate: %v", err)
	}
	if harness.runCalls != 0 {
		t.Fatal("harness was invoked despite OOM safety gate")
	}
}

func TestSpecDecoderIsStrictAndModelIDIsNotAURLOrPath(t *testing.T) {
	spec := validSpec()
	raw, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeSpec(raw); err != nil {
		t.Fatal(err)
	}
	for _, raw := range [][]byte{
		[]byte(`{"schema_version":"provider-runtime-benchmark-spec-v1","schema_version":"provider-runtime-benchmark-spec-v1"}`),
		append(raw[:len(raw)-1], []byte(`,"prompt":"private"}`)...),
	} {
		if _, err := DecodeSpec(raw); err == nil {
			t.Fatal("adversarial spec was accepted")
		}
	}
	for _, value := range []string{"https://example.test/model", "https:example.com/model", "file:tmp/model", "C:/models/qwen", "/models/qwen", "vendor/../qwen", "vendor\\qwen", "127.0.0.1", "hf:127.0.0.1/model"} {
		spec := validSpec()
		spec.ModelID = value
		if validateSpec(spec) == nil {
			t.Fatalf("unsafe model id was accepted: %q", value)
		}
	}
}

func TestPackagedSpecExampleMatchesGolden(t *testing.T) {
	example, err := os.ReadFile(filepath.Join("..", "..", "packaging", "examples", "runtime-benchmark-spec.json"))
	if err != nil {
		t.Fatal(err)
	}
	golden, err := os.ReadFile(filepath.Join("testdata", "spec-v1.golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(example, golden) {
		t.Fatal("benchmark spec example drifted from reviewed golden")
	}
	if _, err := DecodeSpec(example); err != nil {
		t.Fatal(err)
	}
}

func TestStoreIsBoundedAtomic0600AndRejectsTampering(t *testing.T) {
	result, _ := runSuccessfulBenchmark(t)
	path := filepath.Join(t.TempDir(), "benchmarks.json")
	store, err := NewStore(path, StoreOptions{MaximumResults: 1})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Append(result); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 || !info.Mode().IsRegular() {
		t.Fatalf("unsafe store permissions: %v", info.Mode())
	}
	second := result
	second.BenchmarkID = "bench-002"
	second.CompletedAt = second.CompletedAt.Add(time.Second)
	second.ResultDigest = ""
	second.ResultDigest, err = ResultDigest(second)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Append(second); err != nil {
		t.Fatal(err)
	}
	document, err := store.Read()
	if err != nil {
		t.Fatal(err)
	}
	if len(document.Results) != 1 || document.Results[0].BenchmarkID != "bench-002" {
		t.Fatalf("store bound was not enforced: %#v", document)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Read(); err == nil {
		t.Fatal("over-permissive store was accepted")
	}
}

func TestStoreRejectsDuplicateKeysAndSymlink(t *testing.T) {
	directory := t.TempDir()
	path := filepath.Join(directory, "benchmarks.json")
	if err := os.WriteFile(path, []byte(`{"schema_version":"provider-runtime-benchmark-store-v1","schema_version":"provider-runtime-benchmark-store-v1","results":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := NewStore(path, StoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.Read(); err == nil {
		t.Fatal("duplicate JSON key was accepted")
	}
	target := filepath.Join(directory, "target.json")
	if err := os.WriteFile(target, []byte(`{"schema_version":"provider-runtime-benchmark-store-v1","results":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(directory, "link.json")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	linkedStore, err := NewStore(link, StoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := linkedStore.Read(); err == nil {
		t.Fatal("symlink store was accepted")
	}
}
