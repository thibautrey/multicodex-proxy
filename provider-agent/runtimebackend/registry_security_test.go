package runtimebackend_test

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/thibautrey/multivibe/provider-agent/runtimebackend"
	"github.com/thibautrey/multivibe/provider-agent/runtimebackend/contracttest"
)

const registrySecret = "private-prompt-registry-sentinel"

type registryProbeBackend struct {
	descriptor            runtimebackend.Descriptor
	calls                 atomic.Uint64
	failure               error
	panicMethod           string
	panicDescriptor       bool
	invalidMethod         string
	streamMode            string
	blockUntilContextDone bool
	executeStarted        chan struct{}
	executeRelease        <-chan struct{}
	executeStartOnce      sync.Once
}

func newRegistryProbe(id string) *registryProbeBackend {
	return &registryProbeBackend{descriptor: contracttest.DefaultDescriptor(id)}
}

func (backend *registryProbeBackend) Descriptor() runtimebackend.Descriptor {
	if backend.panicDescriptor {
		panic(registrySecret)
	}
	return backend.descriptor
}

func (backend *registryProbeBackend) before(ctx context.Context, method string) error {
	backend.calls.Add(1)
	if backend.panicMethod == method {
		panic(registrySecret)
	}
	if backend.failure != nil {
		return backend.failure
	}
	if backend.blockUntilContextDone {
		<-ctx.Done()
	}
	return nil
}

func (backend *registryProbeBackend) Discover(ctx context.Context, _ runtimebackend.OperationGrant) (runtimebackend.Discovery, error) {
	if err := backend.before(ctx, "discover"); err != nil {
		return runtimebackend.Discovery{}, err
	}
	if backend.invalidMethod == "discover" {
		return runtimebackend.Discovery{Accelerators: []runtimebackend.Accelerator{{Profile: registrySecret}}}, nil
	}
	accelerators := make([]runtimebackend.Accelerator, 0, len(backend.descriptor.Accelerators))
	for _, constraint := range backend.descriptor.Accelerators {
		accelerators = append(accelerators, runtimebackend.Accelerator{
			Profile: constraint.Profile, OS: constraint.OS, Architecture: constraint.Architecture, Kind: constraint.Kind,
			MemoryBytes: backend.descriptor.Limits.MaximumMemoryBytes,
		})
	}
	return runtimebackend.Discovery{Accelerators: accelerators}, nil
}

func (backend *registryProbeBackend) Compatible(ctx context.Context, _ runtimebackend.CompatibilityRequest) (runtimebackend.Compatibility, error) {
	if err := backend.before(ctx, "compatible"); err != nil {
		return runtimebackend.Compatibility{}, err
	}
	if backend.invalidMethod == "compatible" {
		return runtimebackend.Compatibility{}, nil
	}
	return runtimebackend.Compatibility{Compatible: true, Reasons: []runtimebackend.ReasonCode{runtimebackend.ReasonEligible}}, nil
}

func (backend *registryProbeBackend) Prepare(ctx context.Context, _ runtimebackend.OperationGrant) (runtimebackend.Health, error) {
	return backend.healthResult(ctx, "prepare")
}

func (backend *registryProbeBackend) Download(ctx context.Context, request runtimebackend.DownloadRequest) (runtimebackend.DownloadedModel, error) {
	if err := backend.before(ctx, "download"); err != nil {
		return runtimebackend.DownloadedModel{}, err
	}
	if backend.invalidMethod == "download" {
		return runtimebackend.DownloadedModel{BackendID: "wrong-backend", ModelID: request.Model.ID}, nil
	}
	return runtimebackend.DownloadedModel{
		BackendID: backend.descriptor.ID, ModelID: request.Model.ID,
		ContentDigest: request.Model.ContentDigest, Bytes: request.Model.ArtifactBytes,
	}, nil
}

func (backend *registryProbeBackend) Start(ctx context.Context, _ runtimebackend.OperationGrant) (runtimebackend.Health, error) {
	return backend.healthResult(ctx, "start")
}

func (backend *registryProbeBackend) Load(ctx context.Context, request runtimebackend.LoadRequest) (runtimebackend.LoadedModel, error) {
	if err := backend.before(ctx, "load"); err != nil {
		return runtimebackend.LoadedModel{}, err
	}
	if backend.invalidMethod == "load" {
		return runtimebackend.LoadedModel{BackendID: "wrong-backend", ModelID: request.Model.ID}, nil
	}
	return runtimebackend.LoadedModel{
		BackendID: backend.descriptor.ID, ModelID: request.Model.ID, ContentDigest: request.Model.ContentDigest,
	}, nil
}

func (backend *registryProbeBackend) Health(ctx context.Context, _ runtimebackend.OperationGrant) (runtimebackend.Health, error) {
	return backend.healthResult(ctx, "health")
}

func (backend *registryProbeBackend) healthResult(ctx context.Context, method string) (runtimebackend.Health, error) {
	if err := backend.before(ctx, method); err != nil {
		return runtimebackend.Health{}, err
	}
	if backend.invalidMethod == method {
		return runtimebackend.Health{State: "/private/adapter-state"}, nil
	}
	return runtimebackend.Health{State: "running", Installed: true, Running: true}, nil
}

func (backend *registryProbeBackend) Ready(ctx context.Context, _ runtimebackend.OperationGrant) (runtimebackend.Readiness, error) {
	if err := backend.before(ctx, "ready"); err != nil {
		return runtimebackend.Readiness{}, err
	}
	if backend.invalidMethod == "ready" {
		return runtimebackend.Readiness{}, nil
	}
	return runtimebackend.Readiness{Ready: true, Reason: runtimebackend.ReasonEligible}, nil
}

func (backend *registryProbeBackend) Metrics(ctx context.Context, _ runtimebackend.OperationGrant) (runtimebackend.Metrics, error) {
	if err := backend.before(ctx, "metrics"); err != nil {
		return runtimebackend.Metrics{}, err
	}
	if backend.invalidMethod == "metrics" {
		return runtimebackend.Metrics{SchemaVersion: registrySecret}, nil
	}
	return runtimebackend.Metrics{SchemaVersion: runtimebackend.MetricsVersion, Running: true}, nil
}

func (backend *registryProbeBackend) Cleanup(ctx context.Context, _ runtimebackend.CleanupRequest) error {
	return backend.before(ctx, "cleanup")
}

func (backend *registryProbeBackend) Stop(ctx context.Context, _ runtimebackend.OperationGrant) error {
	return backend.before(ctx, "stop")
}

func (backend *registryProbeBackend) Execute(ctx context.Context, request runtimebackend.ExecutionRequest) (runtimebackend.ExecutionResult, error) {
	if err := backend.before(ctx, "execute"); err != nil {
		return runtimebackend.ExecutionResult{}, err
	}
	if backend.executeRelease != nil {
		backend.executeStartOnce.Do(func() { close(backend.executeStarted) })
		select {
		case <-ctx.Done():
			return runtimebackend.ExecutionResult{}, ctx.Err()
		case <-backend.executeRelease:
		}
	}
	if backend.invalidMethod == "execute" {
		return runtimebackend.ExecutionResult{Output: make([]byte, int(request.MaximumOutputBytes)+1)}, nil
	}
	output := append([]byte(nil), request.Input...)
	if uint64(len(output)) > request.MaximumOutputBytes {
		output = output[:request.MaximumOutputBytes]
	}
	return runtimebackend.ExecutionResult{Output: output}, nil
}

func (backend *registryProbeBackend) ExecuteStream(
	ctx context.Context,
	_ runtimebackend.ExecutionRequest,
	emit runtimebackend.EmitFunc,
) (runtimebackend.ExecutionSummary, error) {
	if err := backend.before(ctx, "stream"); err != nil {
		return runtimebackend.ExecutionSummary{}, err
	}
	if backend.blockUntilContextDone {
		_ = emit(runtimebackend.ExecutionChunk{Event: runtimebackend.ExecutionEventOutput, Output: []byte("ok"), Final: true})
		return runtimebackend.ExecutionSummary{OutputBytes: 2, OutputTokens: 1}, nil
	}
	switch backend.streamMode {
	case "oversized":
		_ = emit(runtimebackend.ExecutionChunk{Event: runtimebackend.ExecutionEventOutput, Output: []byte("12345"), Final: true})
		return runtimebackend.ExecutionSummary{OutputBytes: 5, OutputTokens: 1}, nil
	case "cumulative":
		_ = emit(runtimebackend.ExecutionChunk{Event: runtimebackend.ExecutionEventOutput, Output: []byte("abc")})
		_ = emit(runtimebackend.ExecutionChunk{Event: runtimebackend.ExecutionEventOutput, Output: []byte("de"), Final: true})
		return runtimebackend.ExecutionSummary{OutputBytes: 5, OutputTokens: 1}, nil
	case "invalid-event":
		_ = emit(runtimebackend.ExecutionChunk{Event: runtimebackend.ExecutionEvent(registrySecret), Output: []byte("x"), Final: true})
		return runtimebackend.ExecutionSummary{OutputBytes: 1, OutputTokens: 1}, nil
	case "multiple-finals":
		_ = emit(runtimebackend.ExecutionChunk{Event: runtimebackend.ExecutionEventOutput, Output: []byte("a"), Final: true})
		_ = emit(runtimebackend.ExecutionChunk{Event: runtimebackend.ExecutionEventOutput, Output: []byte("b"), Final: true})
		return runtimebackend.ExecutionSummary{OutputBytes: 2, OutputTokens: 2}, nil
	case "no-final":
		_ = emit(runtimebackend.ExecutionChunk{Event: runtimebackend.ExecutionEventOutput, Output: []byte("a")})
		return runtimebackend.ExecutionSummary{OutputBytes: 1, OutputTokens: 1}, nil
	case "summary-mismatch":
		_ = emit(runtimebackend.ExecutionChunk{Event: runtimebackend.ExecutionEventOutput, Output: []byte("ok"), Final: true})
		return runtimebackend.ExecutionSummary{OutputBytes: 3, OutputTokens: 1}, nil
	case "zero-tokens":
		_ = emit(runtimebackend.ExecutionChunk{Event: runtimebackend.ExecutionEventOutput, Output: []byte("ok"), Final: true})
		return runtimebackend.ExecutionSummary{OutputBytes: 2}, nil
	default:
		if err := emit(runtimebackend.ExecutionChunk{Event: runtimebackend.ExecutionEventOutput, Output: []byte("ok"), Final: true}); err != nil {
			return runtimebackend.ExecutionSummary{}, fmt.Errorf("adapter-callback-wrapper-%s: %w", registrySecret, err)
		}
		return runtimebackend.ExecutionSummary{OutputBytes: 2, OutputTokens: 1}, nil
	}
}

func (backend *registryProbeBackend) Cancel(ctx context.Context, _ runtimebackend.CancelRequest) error {
	if err := backend.before(ctx, "cancel"); err != nil {
		return err
	}
	return runtimebackend.ErrExecutionUnknown
}

func registerProbe(t *testing.T, backend *registryProbeBackend) runtimebackend.Backend {
	t.Helper()
	registry, err := runtimebackend.NewRegistry(backend)
	if err != nil {
		t.Fatal(err)
	}
	registered, found := registry.Backend(backend.descriptor.ID)
	if !found {
		t.Fatal("registered probe is missing")
	}
	return registered
}

func probeFixture(at time.Time, backend *registryProbeBackend) contracttest.Fixture {
	fixture := contracttest.DefaultFixture(at)
	fixture.Grant.ExpiresAt = at.Add(time.Hour)
	return fixture
}

func invokeProbeSurface(
	name string,
	backend runtimebackend.Backend,
	fixture contracttest.Fixture,
	emit runtimebackend.EmitFunc,
) (any, error) {
	ctx := context.Background()
	download := runtimebackend.DownloadedModel{
		BackendID: backend.Descriptor().ID, ModelID: fixture.Model.ID,
		ContentDigest: fixture.Model.ContentDigest, Bytes: fixture.Model.ArtifactBytes,
	}
	execution := runtimebackend.ExecutionRequest{
		Grant: fixture.Grant, ExecutionID: "registry-probe", ModelID: fixture.Model.ID,
		TrafficClass: fixture.Grant.TrafficClass, Input: []byte("safe"), MaximumOutputBytes: 4,
	}
	switch name {
	case "discover":
		return backend.Discover(ctx, fixture.Grant)
	case "compatible":
		constraint := backend.Descriptor().Accelerators[0]
		return backend.Compatible(ctx, runtimebackend.CompatibilityRequest{
			Grant: fixture.Grant, EvaluationTime: fixture.EvaluationTime,
			Accelerator: runtimebackend.Accelerator{
				Profile: constraint.Profile, OS: constraint.OS, Architecture: constraint.Architecture, Kind: constraint.Kind,
				MemoryBytes: backend.Descriptor().Limits.MaximumMemoryBytes,
			},
			Model: fixture.Model,
			RequiredCapabilities: runtimebackend.CapabilityRequirements{
				Execute: true, Stream: true, Cancel: true,
			},
		})
	case "prepare":
		return backend.Prepare(ctx, fixture.Grant)
	case "download":
		return backend.Download(ctx, runtimebackend.DownloadRequest{Grant: fixture.Grant, Model: fixture.Model})
	case "start":
		return backend.Start(ctx, fixture.Grant)
	case "load":
		return backend.Load(ctx, runtimebackend.LoadRequest{Grant: fixture.Grant, Model: fixture.Model, Download: download})
	case "health":
		return backend.Health(ctx, fixture.Grant)
	case "ready":
		return backend.Ready(ctx, fixture.Grant)
	case "metrics":
		return backend.Metrics(ctx, fixture.Grant)
	case "cleanup":
		return nil, backend.Cleanup(ctx, runtimebackend.CleanupRequest{Grant: fixture.Grant, ModelIDs: []string{fixture.Model.ID}})
	case "stop":
		return nil, backend.Stop(ctx, fixture.Grant)
	case "execute":
		return backend.(runtimebackend.Executor).Execute(ctx, execution)
	case "stream":
		return backend.(runtimebackend.StreamExecutor).ExecuteStream(ctx, execution, emit)
	case "cancel":
		return nil, backend.(runtimebackend.Canceller).Cancel(ctx, runtimebackend.CancelRequest{
			Grant: fixture.Grant, ExecutionID: execution.ExecutionID,
		})
	default:
		panic("unknown test surface")
	}
}

func TestRegistryCanonicalizesErrorsAcrossEveryAdapterSurface(t *testing.T) {
	probe := newRegistryProbe("canonical-errors")
	probe.failure = fmt.Errorf("%s: %w", registrySecret, runtimebackend.ErrCrashed)
	registered := registerProbe(t, probe)
	fixture := probeFixture(time.Now().UTC(), probe)
	for _, surface := range []string{
		"discover", "compatible", "prepare", "download", "start", "load", "health", "ready", "metrics",
		"cleanup", "stop", "execute", "stream", "cancel",
	} {
		t.Run(surface, func(t *testing.T) {
			_, err := invokeProbeSurface(surface, registered, fixture, func(runtimebackend.ExecutionChunk) error { return nil })
			if err != runtimebackend.ErrCrashed || strings.Contains(err.Error(), registrySecret) {
				t.Fatalf("adapter error escaped canonicalization: %v", err)
			}
		})
	}

	probe.failure = errors.New(registrySecret)
	_, err := registered.Health(context.Background(), fixture.Grant)
	if err != runtimebackend.ErrBackendFailure || strings.Contains(err.Error(), registrySecret) {
		t.Fatalf("unknown adapter error escaped canonicalization: %v", err)
	}
}

func TestRegistryRecoversAdapterPanicsAcrossEverySurface(t *testing.T) {
	for _, surface := range []string{
		"discover", "compatible", "prepare", "download", "start", "load", "health", "ready", "metrics",
		"cleanup", "stop", "execute", "stream", "cancel",
	} {
		t.Run(surface, func(t *testing.T) {
			probe := newRegistryProbe("panic-" + strings.ReplaceAll(surface, "_", "-"))
			registered := registerProbe(t, probe)
			probe.panicMethod = surface
			fixture := probeFixture(time.Now().UTC(), probe)
			_, err := invokeProbeSurface(surface, registered, fixture, func(runtimebackend.ExecutionChunk) error { return nil })
			if err != runtimebackend.ErrBackendFailure || strings.Contains(err.Error(), registrySecret) {
				t.Fatalf("adapter panic crossed registry boundary: %v", err)
			}
		})
	}

	probe := newRegistryProbe("panic-descriptor")
	probe.panicDescriptor = true
	if _, err := runtimebackend.NewRegistry(probe); err != runtimebackend.ErrBackendFailure {
		t.Fatalf("descriptor panic crossed registry construction: %v", err)
	}
}

func TestRegistryRejectsInvalidAdapterResults(t *testing.T) {
	for _, surface := range []string{
		"discover", "compatible", "prepare", "download", "start", "load", "health", "ready", "metrics", "execute",
	} {
		t.Run(surface, func(t *testing.T) {
			probe := newRegistryProbe("invalid-" + surface)
			registered := registerProbe(t, probe)
			probe.invalidMethod = surface
			value, err := invokeProbeSurface(surface, registered, probeFixture(time.Now().UTC(), probe), func(runtimebackend.ExecutionChunk) error { return nil })
			if err != runtimebackend.ErrBackendFailure {
				t.Fatalf("invalid adapter result was accepted: %#v err=%v", value, err)
			}
			if value != nil && !reflect.ValueOf(value).IsZero() {
				t.Fatalf("invalid adapter result was exposed: %#v", value)
			}
		})
	}
}

func TestRegistryRejectsRequestsBeforeTheyReachAdapter(t *testing.T) {
	tests := []struct {
		name   string
		want   error
		mutate func(*runtimebackend.ExecutionRequest) context.Context
	}{
		{
			name: "expired grant", want: runtimebackend.ErrGrantExpired,
			mutate: func(request *runtimebackend.ExecutionRequest) context.Context {
				request.Grant.IssuedAt = time.Now().Add(-time.Hour)
				request.Grant.ExpiresAt = time.Now().Add(-time.Second)
				return context.Background()
			},
		},
		{
			name: "forbidden model", want: runtimebackend.ErrInvalid,
			mutate: func(request *runtimebackend.ExecutionRequest) context.Context {
				request.ModelID = "hf:forbidden/model"
				return context.Background()
			},
		},
		{
			name: "grant exceeds descriptor", want: runtimebackend.ErrInvalid,
			mutate: func(request *runtimebackend.ExecutionRequest) context.Context {
				request.Grant.Limits.MaximumOutputBytes = 1 << 21
				return context.Background()
			},
		},
		{
			name: "customer traffic on shadow backend", want: runtimebackend.ErrExecutionDisabled,
			mutate: func(request *runtimebackend.ExecutionRequest) context.Context {
				request.Grant.TrafficClass = runtimebackend.TrafficClassCustomer
				request.TrafficClass = runtimebackend.TrafficClassCustomer
				return context.Background()
			},
		},
		{
			name: "cancelled context", want: runtimebackend.ErrCancelled,
			mutate: func(_ *runtimebackend.ExecutionRequest) context.Context {
				ctx, cancel := context.WithCancel(context.Background())
				cancel()
				return ctx
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			probe := newRegistryProbe("reject-before-adapter")
			registered := registerProbe(t, probe)
			fixture := probeFixture(time.Now().UTC(), probe)
			request := runtimebackend.ExecutionRequest{
				Grant: fixture.Grant, ExecutionID: "reject-before-adapter", ModelID: fixture.Model.ID,
				TrafficClass: fixture.Grant.TrafficClass, Input: []byte("safe"), MaximumOutputBytes: 4,
			}
			ctx := test.mutate(&request)
			result, err := registered.(runtimebackend.Executor).Execute(ctx, request)
			if err != test.want || len(result.Output) != 0 {
				t.Fatalf("request was not rejected safely: output=%d err=%v", len(result.Output), err)
			}
			if probe.calls.Load() != 0 {
				t.Fatalf("rejected request reached adapter: calls=%d", probe.calls.Load())
			}
		})
	}
}

func TestRegistryEnforcesConcurrencyBeforeAdapter(t *testing.T) {
	probe := newRegistryProbe("registry-concurrency")
	started := make(chan struct{})
	release := make(chan struct{})
	probe.executeStarted = started
	probe.executeRelease = release
	registered := registerProbe(t, probe)
	fixture := probeFixture(time.Now().UTC(), probe)
	fixture.Grant.Limits.MaximumConcurrency = 1
	request := runtimebackend.ExecutionRequest{
		Grant: fixture.Grant, ExecutionID: "first", ModelID: fixture.Model.ID,
		TrafficClass: fixture.Grant.TrafficClass, Input: []byte("safe"), MaximumOutputBytes: 4,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	firstResult := make(chan error, 1)
	go func() {
		_, err := registered.(runtimebackend.Executor).Execute(ctx, request)
		firstResult <- err
	}()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("first execution did not reach adapter")
	}
	second := request
	second.ExecutionID = "second"
	if _, err := registered.(runtimebackend.Executor).Execute(ctx, second); err != runtimebackend.ErrIncompatible {
		t.Fatalf("concurrency ceiling was not enforced: %v", err)
	}
	if probe.calls.Load() != 1 {
		t.Fatalf("rejected concurrent execution reached adapter: calls=%d", probe.calls.Load())
	}
	close(release)
	if err := <-firstResult; err != nil {
		t.Fatalf("first execution failed after release: %v", err)
	}
}

func TestRegistryRejectsSuccessAfterGrantExpiration(t *testing.T) {
	for _, surface := range []string{"prepare", "download", "start", "load", "cleanup", "stop", "execute", "stream", "cancel"} {
		t.Run(surface, func(t *testing.T) {
			probe := newRegistryProbe("lease-" + surface)
			probe.blockUntilContextDone = true
			registered := registerProbe(t, probe)
			now := time.Now().UTC()
			fixture := probeFixture(now, probe)
			fixture.EvaluationTime = now
			fixture.Grant.IssuedAt = now.Add(-time.Minute)
			fixture.Grant.ExpiresAt = time.Now().Add(40 * time.Millisecond)
			emitted := atomic.Uint64{}
			_, err := invokeProbeSurface(surface, registered, fixture, func(chunk runtimebackend.ExecutionChunk) error {
				emitted.Add(uint64(len(chunk.Output)))
				return nil
			})
			if err != runtimebackend.ErrGrantExpired || strings.Contains(err.Error(), registrySecret) {
				t.Fatalf("post-expiration success was accepted: %v", err)
			}
			if surface == "stream" && emitted.Load() != 0 {
				t.Fatalf("post-expiration stream output reached callback: %d", emitted.Load())
			}
			if probe.calls.Load() != 1 {
				t.Fatalf("adapter was not called exactly once: %d", probe.calls.Load())
			}
		})
	}
}

func TestRegistryRejectsAdversarialStreamsAndCallbackFailures(t *testing.T) {
	tests := []struct {
		name           string
		mode           string
		wantDelivered  string
		callbackError  bool
		callbackPanics bool
	}{
		{name: "oversized chunk", mode: "oversized"},
		{name: "cumulative overflow", mode: "cumulative", wantDelivered: "abc"},
		{name: "invalid event", mode: "invalid-event"},
		{name: "multiple finals", mode: "multiple-finals", wantDelivered: "a"},
		{name: "missing final", mode: "no-final", wantDelivered: "a"},
		{name: "summary mismatch", mode: "summary-mismatch", wantDelivered: "ok"},
		{name: "zero tokens", mode: "zero-tokens", wantDelivered: "ok"},
		{name: "callback secret", wantDelivered: "ok", callbackError: true},
		{name: "callback panic", wantDelivered: "ok", callbackPanics: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			probe := newRegistryProbe("stream-adversarial")
			probe.streamMode = test.mode
			registered := registerProbe(t, probe)
			fixture := probeFixture(time.Now().UTC(), probe)
			var delivered bytes.Buffer
			_, err := invokeProbeSurface("stream", registered, fixture, func(chunk runtimebackend.ExecutionChunk) error {
				delivered.Write(chunk.Output)
				if test.callbackPanics {
					panic(registrySecret)
				}
				if test.callbackError {
					return errors.New(registrySecret)
				}
				return nil
			})
			if err != runtimebackend.ErrBackendFailure || strings.Contains(err.Error(), registrySecret) {
				t.Fatalf("adversarial stream escaped boundary: delivered=%q err=%v", delivered.String(), err)
			}
			if delivered.String() != test.wantDelivered {
				t.Fatalf("unexpected chunks crossed boundary: got=%q want=%q", delivered.String(), test.wantDelivered)
			}
		})
	}
}

func TestNormalizeExecutionErrorReturnsExactSentinels(t *testing.T) {
	for _, sentinel := range []error{
		runtimebackend.ErrInvalid, runtimebackend.ErrIncompatible, runtimebackend.ErrCapabilityUnavailable,
		runtimebackend.ErrExecutionDisabled, runtimebackend.ErrOutOfMemory, runtimebackend.ErrCrashed,
		runtimebackend.ErrTimedOut, runtimebackend.ErrCancelled, runtimebackend.ErrExecutionUnknown,
		runtimebackend.ErrGrantMismatch, runtimebackend.ErrGrantExpired, runtimebackend.ErrBackendFailure,
	} {
		wrapped := fmt.Errorf("%s: %w", registrySecret, sentinel)
		if normalized := runtimebackend.NormalizeExecutionError(wrapped); normalized != sentinel || strings.Contains(normalized.Error(), registrySecret) {
			t.Fatalf("sentinel wrapper was preserved: %v", normalized)
		}
	}
	if normalized := runtimebackend.NormalizeExecutionError(errors.New(registrySecret)); normalized != runtimebackend.ErrBackendFailure {
		t.Fatalf("unknown error was not reduced to backend failure: %v", normalized)
	}
}

var (
	_ runtimebackend.Backend        = (*registryProbeBackend)(nil)
	_ runtimebackend.Executor       = (*registryProbeBackend)(nil)
	_ runtimebackend.StreamExecutor = (*registryProbeBackend)(nil)
	_ runtimebackend.Canceller      = (*registryProbeBackend)(nil)
)
