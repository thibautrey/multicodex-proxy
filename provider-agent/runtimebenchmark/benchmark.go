// Package runtimebenchmark runs an explicitly enabled, synthetic-only local
// benchmark. Its API cannot accept a user prompt: inputs are deterministic
// public term IDs derived from the fixed seed in Spec. Backend-native counters
// report how each model tokenizer encodes those terms.
package runtimebenchmark

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/thibautrey/multivibe/provider-agent/runtimebackend"
)

const (
	SpecVersion               = "provider-runtime-benchmark-spec-v1"
	ResultVersion             = "provider-runtime-benchmark-result-v1"
	OllamaManagedRuntime      = "ollama-managed"
	SyntheticDataset          = "multivibe-synthetic-term-sequence-v1"
	ReproducibleSeed          = uint64(7)
	ReproducibleTemperature   = uint32(0)
	PrefillBackendNative      = "backend-native"
	PrefillObserved           = "event-observed"
	PrefillTTFTFallback       = "ttft-fallback"
	PrefillMixed              = "mixed"
	PrefillUnavailable        = "unavailable"
	TimingBackendNative       = "backend-native"
	TimingEventClock          = "event-clock"
	TimingMixed               = "mixed"
	TimingUnavailable         = "unavailable"
	MemorySampledDuringRun    = "ollama-api-ps-size-vram-sum-sampled-during-run"
	MemoryUnavailable         = "unavailable"
	HardwareProfileDeclared   = "profile-declared-gpu-use-observed-exact-class-not-attested"
	HardwareProfileOnly       = "profile-declared-only-not-attested"
	BenchmarkPassScope        = "synthetic-runtime-execution-only"
	ContextRuntimeObserved    = "ollama-api-ps-context-length-observed"
	BatchRequestOnly          = "request-accepted-not-runtime-observed"
	ParallelismHarnessOne     = "harness-single-request-not-runtime-capacity"
	GPURequestObserved        = "request-accepted-gpu-use-observed-layer-count-not-observed"
	RuntimeSettingUnavailable = "unavailable"
	maximumRuns               = uint32(50)
	maximumWarmups            = uint32(10)
	maximumSyntheticTerms     = uint32(8192)
	maximumOutputTokens       = uint32(2048)
	maximumContextTokens      = uint64(1 << 20)
	maximumBatchSize          = uint32(4096)
	supportedParallelism      = uint32(1)
	maximumGPUOffloadLayers   = uint32(4096)
)

var (
	ErrInvalid             = errors.New("runtime benchmark input is invalid")
	ErrDisabled            = errors.New("runtime benchmark is not explicitly enabled")
	ErrDestructiveDisabled = errors.New("destructive OOM benchmark is not explicitly enabled")
	ErrProtocol            = errors.New("runtime benchmark protocol violation")

	idPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)
	namePattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,127}$`)
	modelPattern  = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}:[a-z0-9][a-z0-9._-]{0,63}/[a-z0-9][a-z0-9._-]{0,127}(/[a-z0-9][a-z0-9._-]{0,127})*$`)
	digestPattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
)

type Spec struct {
	SchemaVersion          string          `json:"schema_version"`
	Enabled                bool            `json:"enabled"`
	BenchmarkID            string          `json:"benchmark_id"`
	ProfileID              string          `json:"profile_id"`
	ProfileDigest          string          `json:"profile_digest"`
	CatalogDigest          string          `json:"catalog_digest"`
	ModelID                string          `json:"model_id"`
	ModelContentDigest     string          `json:"model_content_digest"`
	HardwareClass          string          `json:"hardware_class"`
	RuntimeID              string          `json:"runtime_id"`
	Dataset                string          `json:"dataset"`
	Runs                   uint32          `json:"runs"`
	WarmupRuns             uint32          `json:"warmup_runs"`
	SyntheticTerms         uint32          `json:"synthetic_terms"`
	MaximumOutputTokens    uint32          `json:"maximum_output_tokens"`
	RequestedRuntime       RuntimeSettings `json:"requested_runtime_settings"`
	Seed                   uint64          `json:"seed"`
	TemperatureMilli       uint32          `json:"temperature_milli"`
	RunTimeoutMilliseconds uint64          `json:"run_timeout_milliseconds"`
	InduceOOM              bool            `json:"induce_oom"`
}

// RuntimeSettings are explicit runtime request parameters. The benchmark
// reports them as requested settings; adapter-specific evidence states which
// values were independently observed.
type RuntimeSettings struct {
	ContextTokens    uint64 `json:"context_tokens"`
	BatchSize        uint32 `json:"batch_size"`
	Parallelism      uint32 `json:"parallelism"`
	GPUOffloadLayers uint32 `json:"gpu_offload_layers"`
}

// RuntimeSettingsMeasurement describes the evidence available for each
// requested tuning value. Only context length is independently reported by
// Ollama; accepting the other options is not evidence that their exact values
// were applied internally.
type RuntimeSettingsMeasurement struct {
	ContextTokens    string `json:"context_tokens"`
	BatchSize        string `json:"batch_size"`
	Parallelism      string `json:"parallelism"`
	GPUOffloadLayers string `json:"gpu_offload_layers"`
}

// SyntheticWorkload contains only reviewed identifiers and numeric bounds.
// It intentionally has no prompt, text, metadata, path or environment field.
type SyntheticWorkload struct {
	ProfileID          string
	ProfileDigest      string
	ModelID            string
	ModelContentDigest string
	HardwareClass      string
	RuntimeID          string
	RequestedRuntime   RuntimeSettings
}

type SyntheticRequest struct {
	ExecutionID      string
	Dataset          string
	TermIDs          []uint32
	MaximumTokens    uint32
	RequestedRuntime RuntimeSettings
	Seed             uint64
	TemperatureMilli uint32
	InduceOOM        bool
}

type EventKind string

const (
	EventPrefillComplete EventKind = "prefill-complete"
	EventToken           EventKind = "token"
	EventFinal           EventKind = "final"
)

type Event struct {
	Kind       EventKind
	TokenCount uint32
	ObservedAt time.Time
}

type RunSummary struct {
	PromptTokens                 uint32
	OutputTokens                 uint32
	PromptEvalNanoseconds        uint64
	EvalNanoseconds              uint64
	TotalNanoseconds             uint64
	NativeTiming                 bool
	SampledPeakMemoryBytes       uint64
	MemorySamples                uint32
	ObservedRuntimeContextTokens uint64
}

// Harness is the small adapter contract needed for reproducible measurement.
// Runtime adapters can wrap runtimebackend.Backend/StreamExecutor while
// emitting the otherwise unavailable per-execution prefill boundary.
type Harness interface {
	BackendID() string
	Load(context.Context, SyntheticWorkload) error
	RunSynthetic(context.Context, SyntheticRequest, func(Event) error) (RunSummary, error)
	MemoryBytes(context.Context) (uint64, error)
	Unload(context.Context, SyntheticWorkload) error
}

type FailureKind string

const (
	FailureOutOfMemory FailureKind = "out-of-memory"
	FailureCrash       FailureKind = "crash"
	FailureTimeout     FailureKind = "timeout"
	FailureCancelled   FailureKind = "cancelled"
	FailureProtocol    FailureKind = "protocol"
	FailureUnknown     FailureKind = "unknown"
)

type FailureCounts struct {
	OutOfMemory uint32 `json:"out_of_memory"`
	Crash       uint32 `json:"crash"`
	Timeout     uint32 `json:"timeout"`
	Cancelled   uint32 `json:"cancelled"`
	Protocol    uint32 `json:"protocol"`
	Unknown     uint32 `json:"unknown"`
}

type Distribution struct {
	Samples uint32 `json:"samples"`
	Minimum uint64 `json:"minimum"`
	P50     uint64 `json:"p50"`
	P95     uint64 `json:"p95"`
	Maximum uint64 `json:"maximum"`
}

type MemoryResult struct {
	BaselineBytes    uint64       `json:"baseline_bytes"`
	SampledPeakBytes Distribution `json:"sampled_peak_bytes"`
	SamplesPerRun    Distribution `json:"samples_per_run"`
	RecoveryBytes    uint64       `json:"recovery_bytes"`
	Measurement      string       `json:"measurement"`
}

type Result struct {
	SchemaVersion                string                     `json:"schema_version"`
	ResultDigest                 string                     `json:"result_digest"`
	BenchmarkID                  string                     `json:"benchmark_id"`
	SpecVersion                  string                     `json:"spec_version"`
	ProfileID                    string                     `json:"profile_id"`
	ProfileDigest                string                     `json:"profile_digest"`
	CatalogDigest                string                     `json:"catalog_digest"`
	ModelID                      string                     `json:"model_id"`
	ModelContentDigest           string                     `json:"model_content_digest"`
	HardwareClass                string                     `json:"hardware_class"`
	HardwareClassMeasurement     string                     `json:"hardware_class_measurement"`
	RuntimeID                    string                     `json:"runtime_id"`
	RequestedRuntime             RuntimeSettings            `json:"requested_runtime_settings"`
	RuntimeSettingsMeasurement   RuntimeSettingsMeasurement `json:"runtime_settings_measurement"`
	ObservedRuntimeContext       Distribution               `json:"observed_runtime_context_tokens"`
	PassScope                    string                     `json:"pass_scope"`
	ProfileCompatibilityAttested bool                       `json:"profile_compatibility_attested"`
	Dataset                      string                     `json:"dataset"`
	Seed                         uint64                     `json:"seed"`
	TemperatureMilli             uint32                     `json:"temperature_milli"`
	StartedAt                    time.Time                  `json:"started_at"`
	CompletedAt                  time.Time                  `json:"completed_at"`
	RequestedRuns                uint32                     `json:"requested_runs"`
	WarmupRuns                   uint32                     `json:"warmup_runs"`
	SyntheticTerms               uint32                     `json:"synthetic_terms"`
	MaximumOutputTokens          uint32                     `json:"maximum_output_tokens"`
	ObservedPromptTokens         Distribution               `json:"observed_prompt_tokens"`
	ObservedOutputTokens         Distribution               `json:"observed_output_tokens"`
	RunTimeoutMilliseconds       uint64                     `json:"run_timeout_milliseconds"`
	SuccessfulRuns               uint32                     `json:"successful_runs"`
	StabilityBasisPoints         uint16                     `json:"stability_basis_points"`
	Passed                       bool                       `json:"passed"`
	LoadMilliseconds             Distribution               `json:"load_milliseconds"`
	PrefillMilliseconds          Distribution               `json:"prefill_milliseconds"`
	PrefillMeasurement           string                     `json:"prefill_measurement"`
	GenerationTimingMeasurement  string                     `json:"generation_timing_measurement"`
	TimeToFirstTokenMillis       Distribution               `json:"time_to_first_token_milliseconds"`
	EndToEndMilliseconds         Distribution               `json:"end_to_end_milliseconds"`
	TokensPerSecondMilli         Distribution               `json:"tokens_per_second_milli"`
	Memory                       MemoryResult               `json:"memory"`
	Failures                     FailureCounts              `json:"failures"`
}

type Options struct {
	AllowDestructiveOOM bool
	Now                 func() time.Time
}

type Runner struct {
	allowDestructiveOOM bool
	now                 func() time.Time
}

func NewRunner(options Options) *Runner {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	return &Runner{allowDestructiveOOM: options.AllowDestructiveOOM, now: now}
}

func (runner *Runner) Run(ctx context.Context, harness Harness, spec Spec) (result Result, returnedErr error) {
	if runner == nil || runner.now == nil || harness == nil || validateSpec(spec) != nil {
		return Result{}, ErrInvalid
	}
	if !spec.Enabled {
		return Result{}, ErrDisabled
	}
	if spec.InduceOOM && !runner.allowDestructiveOOM {
		return Result{}, ErrDestructiveDisabled
	}
	if harness.BackendID() != spec.RuntimeID {
		return Result{}, ErrInvalid
	}
	workload := SyntheticWorkload{
		ProfileID: spec.ProfileID, ProfileDigest: spec.ProfileDigest, ModelID: spec.ModelID,
		ModelContentDigest: spec.ModelContentDigest, HardwareClass: spec.HardwareClass, RuntimeID: spec.RuntimeID,
		RequestedRuntime: spec.RequestedRuntime,
	}
	result = newResult(spec, runner.now())
	// An explicit benchmark starts from an unloaded model so load time is a
	// cold measurement. Harnesses must scope Unload to this exact workload.
	if err := harness.Unload(ctx, workload); err != nil {
		return Result{}, err
	}
	baseline, err := harness.MemoryBytes(ctx)
	if err != nil {
		return Result{}, fmt.Errorf("%w: baseline memory unavailable", ErrInvalid)
	}
	result.Memory.BaselineBytes = baseline
	loadStart := runner.now()
	if err := harness.Load(ctx, workload); err != nil {
		incrementFailure(&result.Failures, classifyFailure(err))
		result.CompletedAt = runner.now().UTC()
		finalized, finalizeErr := finalizeResult(
			result, []uint64{durationMilliseconds(loadStart, result.CompletedAt)}, nil, nil, nil, nil, nil, nil, nil, nil, nil,
			PrefillUnavailable, TimingUnavailable,
		)
		if finalizeErr != nil {
			return Result{}, finalizeErr
		}
		return finalized, err
	}
	loaded := true
	defer func() {
		if loaded {
			if err := harness.Unload(context.WithoutCancel(ctx), workload); returnedErr == nil && err != nil {
				returnedErr = err
			}
		}
	}()
	loadEnd := runner.now()
	loadSamples := []uint64{durationMilliseconds(loadStart, loadEnd)}
	terms := syntheticTermIDs(spec.Seed, spec.SyntheticTerms)
	for warmup := uint32(0); warmup < spec.WarmupRuns; warmup++ {
		request := syntheticRequest(spec, terms, "warmup", warmup)
		if _, _, err := runner.runOne(ctx, harness, spec, request); err != nil {
			incrementFailure(&result.Failures, classifyFailure(err))
			break
		}
	}
	prefillSamples := make([]uint64, 0, spec.Runs)
	promptTokenSamples := make([]uint64, 0, spec.Runs)
	outputTokenSamples := make([]uint64, 0, spec.Runs)
	ttftSamples := make([]uint64, 0, spec.Runs)
	endToEndSamples := make([]uint64, 0, spec.Runs)
	tokensPerSecondSamples := make([]uint64, 0, spec.Runs)
	peakMemorySamples := make([]uint64, 0, spec.Runs)
	memorySampleCounts := make([]uint64, 0, spec.Runs)
	observedContextSamples := make([]uint64, 0, spec.Runs)
	prefillMeasurements := make(map[string]struct{})
	timingMeasurements := make(map[string]struct{})
	for run := uint32(0); run < spec.Runs; run++ {
		request := syntheticRequest(spec, terms, "run", run)
		measurement, peak, err := runner.runOne(ctx, harness, spec, request)
		if err != nil {
			incrementFailure(&result.Failures, classifyFailure(err))
			continue
		}
		result.SuccessfulRuns++
		prefillMeasurements[measurement.prefillMeasurement] = struct{}{}
		timingMeasurements[measurement.timingMeasurement] = struct{}{}
		prefillSamples = append(prefillSamples, measurement.prefillMilliseconds)
		promptTokenSamples = append(promptTokenSamples, uint64(measurement.promptTokens))
		outputTokenSamples = append(outputTokenSamples, uint64(measurement.outputTokens))
		ttftSamples = append(ttftSamples, measurement.timeToFirstTokenMilliseconds)
		endToEndSamples = append(endToEndSamples, measurement.endToEndMilliseconds)
		tokensPerSecondSamples = append(tokensPerSecondSamples, measurement.tokensPerSecondMilli)
		peakMemorySamples = append(peakMemorySamples, peak)
		memorySampleCounts = append(memorySampleCounts, uint64(measurement.memorySamples))
		observedContextSamples = append(observedContextSamples, measurement.observedRuntimeContextTokens)
	}
	if err := harness.Unload(ctx, workload); err != nil {
		incrementFailure(&result.Failures, classifyFailure(err))
	} else {
		loaded = false
	}
	recovery, recoveryErr := harness.MemoryBytes(ctx)
	if recoveryErr != nil {
		incrementFailure(&result.Failures, FailureProtocol)
	} else {
		result.Memory.RecoveryBytes = recovery
	}
	result.CompletedAt = runner.now().UTC()
	finalized, err := finalizeResult(
		result, loadSamples, prefillSamples, promptTokenSamples, outputTokenSamples, ttftSamples, endToEndSamples,
		tokensPerSecondSamples, peakMemorySamples, memorySampleCounts, observedContextSamples,
		measurementName(prefillMeasurements, PrefillUnavailable, PrefillMixed),
		measurementName(timingMeasurements, TimingUnavailable, TimingMixed),
	)
	if err != nil {
		return Result{}, err
	}
	if recoveryErr != nil {
		return finalized, recoveryErr
	}
	return finalized, nil
}

type runMeasurement struct {
	prefillMilliseconds          uint64
	promptTokens                 uint32
	outputTokens                 uint32
	timeToFirstTokenMilliseconds uint64
	endToEndMilliseconds         uint64
	tokensPerSecondMilli         uint64
	memorySamples                uint32
	observedRuntimeContextTokens uint64
	prefillMeasurement           string
	timingMeasurement            string
}

func (runner *Runner) runOne(ctx context.Context, harness Harness, spec Spec, request SyntheticRequest) (runMeasurement, uint64, error) {
	runContext, cancel := context.WithTimeout(ctx, time.Duration(spec.RunTimeoutMilliseconds)*time.Millisecond)
	defer cancel()
	start := runner.now()
	var prefillAt, firstTokenAt, lastTokenAt, finalAt time.Time
	var emittedTokens uint32
	var finalSeen bool
	var prefillObserved bool
	var lastEventAt time.Time
	emit := func(event Event) error {
		now := runner.now()
		if !event.ObservedAt.IsZero() {
			if event.ObservedAt.Before(start) || event.ObservedAt.After(now) {
				return ErrProtocol
			}
			now = event.ObservedAt
		}
		if !lastEventAt.IsZero() && now.Before(lastEventAt) {
			return ErrProtocol
		}
		lastEventAt = now
		switch event.Kind {
		case EventPrefillComplete:
			if !prefillAt.IsZero() || emittedTokens != 0 || event.TokenCount != 0 || finalSeen {
				return ErrProtocol
			}
			prefillAt = now
			prefillObserved = true
		case EventToken:
			if finalSeen || event.TokenCount == 0 || event.TokenCount > spec.MaximumOutputTokens-emittedTokens {
				return ErrProtocol
			}
			if prefillAt.IsZero() {
				// The runtime contract permits a backend to omit this marker.
				// In that case prefill equals TTFT and the report says so.
				prefillAt = now
			}
			emittedTokens += event.TokenCount
			if firstTokenAt.IsZero() {
				firstTokenAt = now
			}
			lastTokenAt = now
		case EventFinal:
			if prefillAt.IsZero() || emittedTokens == 0 || finalSeen || event.TokenCount != 0 {
				return ErrProtocol
			}
			finalSeen = true
			finalAt = now
		default:
			return ErrProtocol
		}
		return nil
	}
	summary, runErr := harness.RunSynthetic(runContext, request, emit)
	if runErr != nil {
		return runMeasurement{}, 0, runErr
	}
	if prefillAt.IsZero() || firstTokenAt.IsZero() || lastTokenAt.IsZero() || finalAt.IsZero() || !finalSeen ||
		emittedTokens == 0 || emittedTokens > spec.MaximumOutputTokens || summary.OutputTokens != emittedTokens ||
		summary.PromptTokens == 0 || uint64(summary.PromptTokens) > spec.RequestedRuntime.ContextTokens ||
		summary.MemorySamples == 0 || summary.SampledPeakMemoryBytes == 0 ||
		summary.ObservedRuntimeContextTokens != spec.RequestedRuntime.ContextTokens {
		return runMeasurement{}, 0, ErrProtocol
	}
	prefillMilliseconds := durationMilliseconds(start, prefillAt)
	endToEndMilliseconds := durationMilliseconds(start, finalAt)
	prefillMeasurement := PrefillObserved
	timingMeasurement := TimingEventClock
	decodeTokens := uint64(emittedTokens - 1)
	decodeNanoseconds := lastTokenAt.Sub(firstTokenAt).Nanoseconds()
	if summary.NativeTiming {
		if summary.PromptEvalNanoseconds == 0 || summary.EvalNanoseconds == 0 || summary.TotalNanoseconds == 0 ||
			summary.EvalNanoseconds > math.MaxInt64 || summary.PromptEvalNanoseconds > math.MaxUint64-summary.EvalNanoseconds ||
			summary.TotalNanoseconds < summary.PromptEvalNanoseconds+summary.EvalNanoseconds {
			return runMeasurement{}, 0, ErrProtocol
		}
		prefillMilliseconds = nanosecondsMilliseconds(summary.PromptEvalNanoseconds)
		endToEndMilliseconds = nanosecondsMilliseconds(summary.TotalNanoseconds)
		prefillMeasurement = PrefillBackendNative
		timingMeasurement = TimingBackendNative
		decodeTokens = uint64(emittedTokens)
		decodeNanoseconds = int64(summary.EvalNanoseconds)
	} else if !prefillObserved {
		prefillMeasurement = PrefillTTFTFallback
	}
	if decodeTokens == 0 || decodeNanoseconds <= 0 {
		return runMeasurement{}, 0, ErrProtocol
	}
	tokensPerSecondMilli, overflow := multiplyDivide(decodeTokens, 1_000_000_000_000, uint64(decodeNanoseconds))
	if overflow || tokensPerSecondMilli == 0 {
		return runMeasurement{}, 0, ErrProtocol
	}
	return runMeasurement{
		prefillMilliseconds:          prefillMilliseconds,
		promptTokens:                 summary.PromptTokens,
		outputTokens:                 summary.OutputTokens,
		timeToFirstTokenMilliseconds: durationMilliseconds(start, firstTokenAt),
		endToEndMilliseconds:         endToEndMilliseconds,
		tokensPerSecondMilli:         tokensPerSecondMilli,
		memorySamples:                summary.MemorySamples,
		observedRuntimeContextTokens: summary.ObservedRuntimeContextTokens,
		prefillMeasurement:           prefillMeasurement,
		timingMeasurement:            timingMeasurement,
	}, summary.SampledPeakMemoryBytes, nil
}

func validateSpec(spec Spec) error {
	if spec.SchemaVersion != SpecVersion || !idPattern.MatchString(spec.BenchmarkID) ||
		!namePattern.MatchString(spec.ProfileID) || !digestPattern.MatchString(spec.ProfileDigest) ||
		!digestPattern.MatchString(spec.CatalogDigest) || !validModelID(spec.ModelID) ||
		!digestPattern.MatchString(spec.ModelContentDigest) || !namePattern.MatchString(spec.HardwareClass) ||
		spec.RuntimeID != OllamaManagedRuntime || spec.Dataset != SyntheticDataset || spec.Runs < 3 || spec.Runs > maximumRuns ||
		spec.WarmupRuns > maximumWarmups || spec.SyntheticTerms < 32 || spec.SyntheticTerms > maximumSyntheticTerms ||
		spec.MaximumOutputTokens < 8 || spec.MaximumOutputTokens > maximumOutputTokens ||
		validateRuntimeSettings(spec.RequestedRuntime) != nil || spec.Seed != ReproducibleSeed ||
		spec.TemperatureMilli != ReproducibleTemperature || spec.RunTimeoutMilliseconds < 100 ||
		spec.RunTimeoutMilliseconds > 30*60*1000 {
		return ErrInvalid
	}
	return nil
}

func newResult(spec Spec, started time.Time) Result {
	return Result{
		SchemaVersion: ResultVersion, BenchmarkID: spec.BenchmarkID, SpecVersion: spec.SchemaVersion,
		ProfileID: spec.ProfileID, ProfileDigest: spec.ProfileDigest, CatalogDigest: spec.CatalogDigest,
		ModelID: spec.ModelID, ModelContentDigest: spec.ModelContentDigest, HardwareClass: spec.HardwareClass,
		HardwareClassMeasurement: HardwareProfileOnly, RuntimeID: spec.RuntimeID, RequestedRuntime: spec.RequestedRuntime,
		RuntimeSettingsMeasurement: unavailableRuntimeSettingsMeasurement(),
		PassScope:                  BenchmarkPassScope, ProfileCompatibilityAttested: false,
		Dataset: spec.Dataset, Seed: spec.Seed, TemperatureMilli: spec.TemperatureMilli,
		StartedAt: started.UTC(), RequestedRuns: spec.Runs, WarmupRuns: spec.WarmupRuns,
		SyntheticTerms: spec.SyntheticTerms, MaximumOutputTokens: spec.MaximumOutputTokens,
		RunTimeoutMilliseconds: spec.RunTimeoutMilliseconds, PrefillMeasurement: PrefillUnavailable,
		GenerationTimingMeasurement: TimingUnavailable, Memory: MemoryResult{Measurement: MemoryUnavailable},
	}
}

func finalizeResult(
	result Result,
	load, prefill, promptTokens, outputTokens, ttft, endToEnd, tokensPerSecond, peakMemory, memorySamples, observedContext []uint64,
	prefillMeasurement, timingMeasurement string,
) (Result, error) {
	result.LoadMilliseconds = distribution(load)
	result.PrefillMilliseconds = distribution(prefill)
	result.ObservedPromptTokens = distribution(promptTokens)
	result.ObservedOutputTokens = distribution(outputTokens)
	result.ObservedRuntimeContext = distribution(observedContext)
	result.TimeToFirstTokenMillis = distribution(ttft)
	result.EndToEndMilliseconds = distribution(endToEnd)
	result.TokensPerSecondMilli = distribution(tokensPerSecond)
	result.Memory.SampledPeakBytes = distribution(peakMemory)
	result.Memory.SamplesPerRun = distribution(memorySamples)
	if result.SuccessfulRuns > 0 {
		result.PrefillMeasurement = prefillMeasurement
		result.GenerationTimingMeasurement = timingMeasurement
		result.Memory.Measurement = MemorySampledDuringRun
		result.HardwareClassMeasurement = HardwareProfileDeclared
		result.RuntimeSettingsMeasurement = RuntimeSettingsMeasurement{
			ContextTokens: ContextRuntimeObserved, BatchSize: BatchRequestOnly,
			Parallelism: ParallelismHarnessOne, GPUOffloadLayers: GPURequestObserved,
		}
	}
	if result.RequestedRuns > 0 {
		result.StabilityBasisPoints = uint16(uint64(result.SuccessfulRuns) * 10_000 / uint64(result.RequestedRuns))
	}
	result.Passed = result.SuccessfulRuns == result.RequestedRuns && failureTotal(result.Failures) == 0 &&
		result.SuccessfulRuns > 0 && recoveredMemory(result.Memory.BaselineBytes, result.Memory.RecoveryBytes) &&
		result.Memory.RecoveryBytes <= result.Memory.SampledPeakBytes.Maximum
	digest, err := ResultDigest(result)
	if err != nil {
		return Result{}, err
	}
	result.ResultDigest = digest
	if validateResult(result) != nil {
		return Result{}, ErrInvalid
	}
	return result, nil
}

func ResultDigest(result Result) (string, error) {
	result.ResultDigest = ""
	raw, err := json.Marshal(result)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(digest[:]), nil
}

func validateResult(result Result) error {
	if result.SchemaVersion != ResultVersion || !digestPattern.MatchString(result.ResultDigest) ||
		!idPattern.MatchString(result.BenchmarkID) || result.SpecVersion != SpecVersion ||
		!namePattern.MatchString(result.ProfileID) || !digestPattern.MatchString(result.ProfileDigest) ||
		!digestPattern.MatchString(result.CatalogDigest) || !validModelID(result.ModelID) ||
		!digestPattern.MatchString(result.ModelContentDigest) || !namePattern.MatchString(result.HardwareClass) ||
		result.RuntimeID != OllamaManagedRuntime || validateRuntimeSettings(result.RequestedRuntime) != nil ||
		result.PassScope != BenchmarkPassScope || result.ProfileCompatibilityAttested ||
		result.Dataset != SyntheticDataset || result.Seed != ReproducibleSeed ||
		!validPrefillMeasurement(result.PrefillMeasurement) || !validTimingMeasurement(result.GenerationTimingMeasurement) ||
		(result.SuccessfulRuns == 0 && result.PrefillMeasurement != PrefillUnavailable) ||
		(result.SuccessfulRuns > 0 && result.PrefillMeasurement == PrefillUnavailable) ||
		(result.SuccessfulRuns == 0 && (result.GenerationTimingMeasurement != TimingUnavailable ||
			result.HardwareClassMeasurement != HardwareProfileOnly || result.Memory.Measurement != MemoryUnavailable ||
			result.RuntimeSettingsMeasurement != unavailableRuntimeSettingsMeasurement())) ||
		(result.SuccessfulRuns > 0 && (result.GenerationTimingMeasurement == TimingUnavailable ||
			result.HardwareClassMeasurement != HardwareProfileDeclared || result.Memory.Measurement != MemorySampledDuringRun ||
			result.RuntimeSettingsMeasurement != (RuntimeSettingsMeasurement{
				ContextTokens: ContextRuntimeObserved, BatchSize: BatchRequestOnly,
				Parallelism: ParallelismHarnessOne, GPUOffloadLayers: GPURequestObserved,
			}))) ||
		result.TemperatureMilli != ReproducibleTemperature || result.StartedAt.IsZero() || result.CompletedAt.Before(result.StartedAt) ||
		result.RequestedRuns < 3 || result.RequestedRuns > maximumRuns || result.SuccessfulRuns > result.RequestedRuns ||
		result.WarmupRuns > maximumWarmups || result.SyntheticTerms < 32 || result.SyntheticTerms > maximumSyntheticTerms ||
		result.MaximumOutputTokens < 8 || result.MaximumOutputTokens > maximumOutputTokens || result.RunTimeoutMilliseconds < 100 ||
		result.RunTimeoutMilliseconds > 30*60*1000 ||
		result.StabilityBasisPoints != uint16(uint64(result.SuccessfulRuns)*10_000/uint64(result.RequestedRuns)) ||
		result.LoadMilliseconds.Samples != 1 || result.PrefillMilliseconds.Samples != result.SuccessfulRuns ||
		result.ObservedPromptTokens.Samples != result.SuccessfulRuns || result.ObservedOutputTokens.Samples != result.SuccessfulRuns ||
		result.ObservedRuntimeContext.Samples != result.SuccessfulRuns ||
		result.TimeToFirstTokenMillis.Samples != result.SuccessfulRuns || result.EndToEndMilliseconds.Samples != result.SuccessfulRuns ||
		result.TokensPerSecondMilli.Samples != result.SuccessfulRuns || result.Memory.SampledPeakBytes.Samples != result.SuccessfulRuns ||
		result.Memory.SamplesPerRun.Samples != result.SuccessfulRuns ||
		validateDistribution(result.LoadMilliseconds, true) != nil || validateDistribution(result.PrefillMilliseconds, result.SuccessfulRuns > 0) != nil ||
		validateDistribution(result.ObservedPromptTokens, result.SuccessfulRuns > 0) != nil ||
		validateDistribution(result.ObservedOutputTokens, result.SuccessfulRuns > 0) != nil ||
		validateDistribution(result.ObservedRuntimeContext, result.SuccessfulRuns > 0) != nil ||
		validateDistribution(result.TimeToFirstTokenMillis, result.SuccessfulRuns > 0) != nil ||
		validateDistribution(result.EndToEndMilliseconds, result.SuccessfulRuns > 0) != nil ||
		validateDistribution(result.TokensPerSecondMilli, result.SuccessfulRuns > 0) != nil ||
		validateDistribution(result.Memory.SampledPeakBytes, result.SuccessfulRuns > 0) != nil ||
		validateDistribution(result.Memory.SamplesPerRun, result.SuccessfulRuns > 0) != nil ||
		(result.SuccessfulRuns > 0 && (result.ObservedPromptTokens.Minimum == 0 || result.ObservedOutputTokens.Minimum == 0 ||
			result.ObservedOutputTokens.Maximum > uint64(result.MaximumOutputTokens) || result.Memory.SamplesPerRun.Minimum == 0 ||
			result.ObservedRuntimeContext.Minimum != result.RequestedRuntime.ContextTokens ||
			result.ObservedRuntimeContext.Maximum != result.RequestedRuntime.ContextTokens)) ||
		(result.Passed != (result.SuccessfulRuns == result.RequestedRuns && failureTotal(result.Failures) == 0 &&
			result.SuccessfulRuns > 0 && recoveredMemory(result.Memory.BaselineBytes, result.Memory.RecoveryBytes) &&
			result.Memory.RecoveryBytes <= result.Memory.SampledPeakBytes.Maximum)) {
		return ErrInvalid
	}
	digest, err := ResultDigest(result)
	if err != nil || digest != result.ResultDigest {
		return ErrInvalid
	}
	return nil
}

func validateDistribution(value Distribution, required bool) error {
	if !required && value.Samples == 0 && value.Minimum == 0 && value.P50 == 0 && value.P95 == 0 && value.Maximum == 0 {
		return nil
	}
	if value.Samples == 0 || value.Minimum > value.P50 || value.P50 > value.P95 || value.P95 > value.Maximum {
		return ErrInvalid
	}
	return nil
}

func syntheticRequest(spec Spec, terms []uint32, phase string, index uint32) SyntheticRequest {
	return SyntheticRequest{
		ExecutionID: fmt.Sprintf("benchmark:%s:%s:%d", spec.BenchmarkID, phase, index), Dataset: spec.Dataset,
		TermIDs: append([]uint32(nil), terms...), MaximumTokens: spec.MaximumOutputTokens,
		RequestedRuntime: spec.RequestedRuntime, Seed: spec.Seed,
		TemperatureMilli: spec.TemperatureMilli, InduceOOM: spec.InduceOOM,
	}
}

func syntheticTermIDs(seed uint64, count uint32) []uint32 {
	state := seed
	result := make([]uint32, count)
	for index := range result {
		state ^= state << 13
		state ^= state >> 7
		state ^= state << 17
		result[index] = uint32(state%32_000) + 1
	}
	return result
}

func validateRuntimeSettings(settings RuntimeSettings) error {
	if settings.ContextTokens == 0 || settings.ContextTokens > maximumContextTokens ||
		settings.BatchSize == 0 || settings.BatchSize > maximumBatchSize ||
		settings.Parallelism != supportedParallelism ||
		settings.GPUOffloadLayers == 0 || settings.GPUOffloadLayers > maximumGPUOffloadLayers {
		return ErrInvalid
	}
	return nil
}

func unavailableRuntimeSettingsMeasurement() RuntimeSettingsMeasurement {
	return RuntimeSettingsMeasurement{
		ContextTokens: RuntimeSettingUnavailable, BatchSize: RuntimeSettingUnavailable,
		Parallelism: RuntimeSettingUnavailable, GPUOffloadLayers: RuntimeSettingUnavailable,
	}
}

func validPrefillMeasurement(value string) bool {
	return value == PrefillBackendNative || value == PrefillObserved || value == PrefillTTFTFallback ||
		value == PrefillMixed || value == PrefillUnavailable
}

func validTimingMeasurement(value string) bool {
	return value == TimingBackendNative || value == TimingEventClock || value == TimingMixed || value == TimingUnavailable
}

func measurementName(values map[string]struct{}, unavailable, mixed string) string {
	if len(values) == 0 {
		return unavailable
	}
	if len(values) > 1 {
		return mixed
	}
	for value := range values {
		return value
	}
	return unavailable
}

func nanosecondsMilliseconds(value uint64) uint64 {
	return value / uint64(time.Millisecond)
}

func distribution(samples []uint64) Distribution {
	if len(samples) == 0 {
		return Distribution{}
	}
	ordered := append([]uint64(nil), samples...)
	sort.Slice(ordered, func(left, right int) bool { return ordered[left] < ordered[right] })
	return Distribution{
		Samples: uint32(len(ordered)), Minimum: ordered[0], P50: percentile(ordered, 50),
		P95: percentile(ordered, 95), Maximum: ordered[len(ordered)-1],
	}
}

func percentile(ordered []uint64, percentage uint64) uint64 {
	index := (uint64(len(ordered))*percentage + 99) / 100
	if index == 0 {
		index = 1
	}
	return ordered[index-1]
}

func durationMilliseconds(start, end time.Time) uint64 {
	if end.Before(start) {
		return 0
	}
	return uint64(end.Sub(start) / time.Millisecond)
}

func multiplyDivide(value, multiplier, divisor uint64) (uint64, bool) {
	if divisor == 0 || (value != 0 && multiplier > math.MaxUint64/value) {
		return 0, true
	}
	return value * multiplier / divisor, false
}

func classifyFailure(err error) FailureKind {
	switch {
	case errors.Is(err, runtimebackend.ErrOutOfMemory):
		return FailureOutOfMemory
	case errors.Is(err, runtimebackend.ErrCrashed):
		return FailureCrash
	case errors.Is(err, runtimebackend.ErrTimedOut), errors.Is(err, context.DeadlineExceeded):
		return FailureTimeout
	case errors.Is(err, runtimebackend.ErrCancelled), errors.Is(err, context.Canceled):
		return FailureCancelled
	case errors.Is(err, ErrProtocol):
		return FailureProtocol
	default:
		return FailureUnknown
	}
}

func incrementFailure(counts *FailureCounts, kind FailureKind) {
	switch kind {
	case FailureOutOfMemory:
		counts.OutOfMemory++
	case FailureCrash:
		counts.Crash++
	case FailureTimeout:
		counts.Timeout++
	case FailureCancelled:
		counts.Cancelled++
	case FailureProtocol:
		counts.Protocol++
	default:
		counts.Unknown++
	}
}

func failureTotal(counts FailureCounts) uint32 {
	return counts.OutOfMemory + counts.Crash + counts.Timeout + counts.Cancelled + counts.Protocol + counts.Unknown
}

func recoveredMemory(baseline, recovery uint64) bool {
	tolerance := uint64(64 << 20)
	if percentage := baseline / 10; percentage > tolerance {
		tolerance = percentage
	}
	if tolerance > math.MaxUint64-baseline {
		return false
	}
	return recovery <= baseline+tolerance
}

func validModelID(value string) bool {
	if len(value) > 192 || !modelPattern.MatchString(value) || strings.Contains(value, "://") || strings.ContainsRune(value, '\\') ||
		strings.HasPrefix(value, "/") || (len(value) >= 3 && value[1] == ':' && value[2] == '/') {
		return false
	}
	namespace, remainder, found := strings.Cut(value, ":")
	if !found || namespace == "http" || namespace == "https" || namespace == "file" || namespace == "ftp" ||
		namespace == "ssh" || namespace == "data" {
		return false
	}
	for _, segment := range strings.Split(remainder, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
		if net.ParseIP(segment) != nil {
			return false
		}
	}
	return true
}
