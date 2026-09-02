package contracttest

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"time"

	"github.com/thibautrey/multivibe/provider-agent/runtimebackend"
)

// TestingT is the testing surface used by Run.
type TestingT interface {
	Helper()
	Fatalf(string, ...any)
}

// Fixture supplies one safe lifecycle/execution contract scenario.
type Fixture struct {
	EvaluationTime time.Time                        `json:"-"`
	Grant          runtimebackend.OperationGrant    `json:"-"`
	Model          runtimebackend.ModelRequirements `json:"model"`
	Input          []byte                           `json:"-"`
	// BlockingInput must keep an execution active until its context is
	// cancelled. It is required when the backend advertises cancellation.
	BlockingInput      []byte                              `json:"-"`
	WaitUntilExecuting func(context.Context, string) error `json:"-"`
}

func (fixture Fixture) String() string {
	return fmt.Sprintf("Fixture{ModelID:%q Input:<redacted:%d bytes> BlockingInput:<redacted:%d bytes> ExecutionObserver:%t}",
		fixture.Model.ID, len(fixture.Input), len(fixture.BlockingInput), fixture.WaitUntilExecuting != nil)
}

func (fixture Fixture) GoString() string { return fixture.String() }

// DefaultFixture creates a short-lived deterministic fixture. The supplied
// time should match a Fake clock when testing Fake.
func DefaultFixture(now time.Time) Fixture {
	limits := runtimebackend.Limits{
		MaximumModels: 2, MaximumConcurrency: 2, MaximumModelBytes: 1 << 30, MaximumMemoryBytes: 1 << 31,
		MaximumContextTokens: 8192, MaximumInputBytes: 1024, MaximumOutputBytes: 1024,
	}
	model := runtimebackend.ModelRequirements{
		ID: "hf:example/model", ContentDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		ArtifactBytes: 1 << 20, EstimatedMemoryBytes: 1 << 21, ContextTokens: 4096,
	}
	return Fixture{
		EvaluationTime: now,
		Grant: runtimebackend.OperationGrant{
			ID: "contract-grant", PolicyRevision: 2, TrafficClass: runtimebackend.TrafficClassShadow,
			IssuedAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Hour),
			AllowedModelIDs: []string{model.ID}, Limits: limits,
		},
		Model: model,
		Input: []byte("contract-probe"), BlockingInput: []byte(BlockingInput),
	}
}

// Run executes the common runtime lifecycle and every advertised optional
// surface. It is designed for isolated test backends, not live production
// runtimes.
func Run(t TestingT, backend runtimebackend.Backend, fixture Fixture) {
	t.Helper()
	if backend == nil {
		t.Fatalf("nil backend")
	}
	descriptor := backend.Descriptor()
	if err := runtimebackend.ValidateDescriptor(descriptor); err != nil {
		t.Fatalf("invalid descriptor: %v", err)
	}
	registry, err := runtimebackend.NewRegistry(backend)
	if err != nil {
		t.Fatalf("registry rejected backend: %v", err)
	}
	snapshot, found := registry.Descriptor(descriptor.ID)
	if !found || !reflect.DeepEqual(snapshot, descriptor) {
		t.Fatalf("registry descriptor snapshot mismatch")
	}
	mutated := snapshot
	mutated.Accelerators[0].Profile = "mutated"
	for platform := range mutated.Provenance.ArtifactSHA256 {
		mutated.Provenance.ArtifactSHA256[platform] = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	}
	stable, _ := registry.Descriptor(descriptor.ID)
	if !reflect.DeepEqual(stable, descriptor) {
		t.Fatalf("registry descriptor is mutable through returned value")
	}
	ctx := context.Background()
	discovery, err := backend.Discover(ctx, fixture.Grant)
	if err != nil || runtimebackend.ValidateDiscovery(descriptor, discovery) != nil {
		t.Fatalf("hardware discovery failed: %#v %v", discovery, err)
	}
	compatibility, err := backend.Compatible(ctx, runtimebackend.CompatibilityRequest{
		Grant: fixture.Grant, EvaluationTime: fixture.EvaluationTime, Accelerator: discovery.Accelerators[0], Model: fixture.Model,
		RequiredCapabilities: runtimebackend.CapabilityRequirements{
			Execute: descriptor.Capabilities.Execute, Stream: descriptor.Capabilities.Stream, Cancel: descriptor.Capabilities.Cancel,
		},
	})
	if err != nil || runtimebackend.ValidateCompatibility(compatibility) != nil || !compatibility.Compatible {
		t.Fatalf("compatibility failed: %#v %v", compatibility, err)
	}
	health, err := backend.Prepare(ctx, fixture.Grant)
	if err != nil || runtimebackend.ValidateHealth(health) != nil || !health.Installed {
		t.Fatalf("prepare failed: %#v %v", health, err)
	}
	downloaded, err := backend.Download(ctx, runtimebackend.DownloadRequest{Grant: fixture.Grant, Model: fixture.Model})
	if err != nil || downloaded.BackendID != descriptor.ID || downloaded.ModelID != fixture.Model.ID || downloaded.ContentDigest != fixture.Model.ContentDigest || downloaded.Bytes != fixture.Model.ArtifactBytes {
		t.Fatalf("download failed: %#v %v", downloaded, err)
	}
	health, err = backend.Start(ctx, fixture.Grant)
	if err != nil || runtimebackend.ValidateHealth(health) != nil || !health.Running {
		t.Fatalf("start failed: %#v %v", health, err)
	}
	loaded, err := backend.Load(ctx, runtimebackend.LoadRequest{Grant: fixture.Grant, Model: fixture.Model, Download: downloaded})
	if err != nil || loaded.BackendID != descriptor.ID || loaded.ModelID != fixture.Model.ID || loaded.ContentDigest != fixture.Model.ContentDigest {
		t.Fatalf("load failed: %#v %v", loaded, err)
	}
	runDirectStopOwnershipChecks(t, backend, fixture.Grant)
	readiness, err := backend.Ready(ctx, fixture.Grant)
	if err != nil || runtimebackend.ValidateReadiness(readiness) != nil || !readiness.Ready {
		t.Fatalf("readiness failed: %#v %v", readiness, err)
	}
	metrics, err := backend.Metrics(ctx, fixture.Grant)
	if err != nil || runtimebackend.ValidateMetrics(descriptor, metrics) != nil || !metrics.Running || metrics.InstalledModels != 1 {
		t.Fatalf("metrics failed: %#v %v", metrics, err)
	}
	request := runtimebackend.ExecutionRequest{
		Grant: fixture.Grant, ExecutionID: "contract-execute", ModelID: fixture.Model.ID, Input: append([]byte{}, fixture.Input...),
		TrafficClass: fixture.Grant.TrafficClass, MaximumOutputBytes: uint64(len(fixture.Input)),
	}
	if descriptor.Capabilities.Execute {
		executor, ok := registry.Executor(descriptor.ID)
		if !ok {
			t.Fatalf("advertised executor unavailable")
		}
		result, executeErr := executor.Execute(ctx, request)
		if executeErr != nil || !reflect.DeepEqual(result.Output, fixture.Input) {
			t.Fatalf("execute failed: output_bytes=%d expected_bytes=%d err=%v", len(result.Output), len(fixture.Input), executeErr)
		}
	}
	if descriptor.Capabilities.Stream {
		streamer, ok := registry.StreamExecutor(descriptor.ID)
		if !ok {
			t.Fatalf("advertised stream executor unavailable")
		}
		request.ExecutionID = "contract-stream"
		streamed := []byte{}
		finals := 0
		summary, streamErr := streamer.ExecuteStream(ctx, request, func(chunk runtimebackend.ExecutionChunk) error {
			streamed = append(streamed, chunk.Output...)
			if chunk.Final {
				finals++
			}
			return nil
		})
		if streamErr != nil || !reflect.DeepEqual(streamed, fixture.Input) || finals != 1 || summary.OutputBytes != uint64(len(streamed)) {
			t.Fatalf("stream failed: output_bytes=%d expected_bytes=%d %#v finals=%d err=%v", len(streamed), len(fixture.Input), summary, finals, streamErr)
		}
	}
	if descriptor.Capabilities.Cancel {
		canceller, ok := registry.Canceller(descriptor.ID)
		if !ok {
			t.Fatalf("advertised canceller unavailable")
		}
		if cancelErr := canceller.Cancel(ctx, runtimebackend.CancelRequest{Grant: fixture.Grant, ExecutionID: "bad id"}); !errors.Is(cancelErr, runtimebackend.ErrInvalid) {
			t.Fatalf("invalid cancellation target accepted: %v", cancelErr)
		}
		cancellationFixture := fixture
		if cancellationFixture.WaitUntilExecuting == nil {
			if observer, ok := backend.(executionObserver); ok {
				cancellationFixture.WaitUntilExecuting = observer.WaitUntilExecuting
			}
		}
		runCancellationOwnershipChecks(t, registry, cancellationFixture)
	}
	if injector, ok := backend.(failureInjector); ok && descriptor.Capabilities.Execute {
		runFailureAndRestartChecks(t, backend, injector, fixture, downloaded)
	}
	if err := backend.Cleanup(ctx, runtimebackend.CleanupRequest{Grant: fixture.Grant, ModelIDs: []string{fixture.Model.ID}, StopRuntime: true}); err != nil {
		t.Fatalf("cleanup failed: %v", err)
	}
	if err := backend.Stop(ctx, fixture.Grant); err != nil {
		t.Fatalf("stop failed: %v", err)
	}
	health, err = backend.Health(ctx, fixture.Grant)
	if err != nil || runtimebackend.ValidateHealth(health) != nil || health.Running {
		t.Fatalf("stop health failed: %#v %v", health, err)
	}
}

func runDirectStopOwnershipChecks(t TestingT, backend runtimebackend.Backend, grant runtimebackend.OperationGrant) {
	t.Helper()
	if grant.PolicyRevision < 2 {
		t.Fatalf("stop ownership fixture requires a previous valid policy revision")
	}
	otherID := grant
	otherID.ID += "-other"
	staleRevision := grant
	staleRevision.PolicyRevision--
	oppositeClass := grant
	if oppositeClass.TrafficClass == runtimebackend.TrafficClassShadow {
		oppositeClass.TrafficClass = runtimebackend.TrafficClassCustomer
	} else {
		oppositeClass.TrafficClass = runtimebackend.TrafficClassShadow
	}
	for label, candidate := range map[string]runtimebackend.OperationGrant{
		"other grant ID":         otherID,
		"stale policy revision":  staleRevision,
		"opposite traffic class": oppositeClass,
	} {
		if err := backend.Stop(context.Background(), candidate); !errors.Is(err, runtimebackend.ErrGrantMismatch) {
			t.Fatalf("%s direct stop crossed runtime ownership: %v", label, err)
		}
		health, err := backend.Health(context.Background(), grant)
		if err != nil || !health.Running {
			t.Fatalf("%s rejected stop mutated runtime health: %#v %v", label, health, err)
		}
	}
}

func runCancellationOwnershipChecks(t TestingT, registry *runtimebackend.Registry, fixture Fixture) {
	t.Helper()
	if len(fixture.BlockingInput) == 0 {
		t.Fatalf("cancellation-capable fixture lacks a blocking input")
	}
	executor, executeOK := registry.Executor(registry.IDs()[0])
	canceller, cancelOK := registry.Canceller(registry.IDs()[0])
	if !executeOK || !cancelOK {
		t.Fatalf("cancellation-capable backend lacks execution interfaces")
	}
	executionContext, stopExecution := context.WithTimeout(context.Background(), 3*time.Second)
	defer stopExecution()
	request := runtimebackend.ExecutionRequest{
		Grant: fixture.Grant, ExecutionID: "contract-blocked", ModelID: fixture.Model.ID,
		TrafficClass: fixture.Grant.TrafficClass, Input: append([]byte{}, fixture.BlockingInput...),
		MaximumOutputBytes: uint64(len(fixture.BlockingInput)),
	}
	result := make(chan error, 1)
	go func() {
		_, err := executor.Execute(executionContext, request)
		result <- err
	}()
	waitUntilExecuting := fixture.WaitUntilExecuting
	if waitUntilExecuting == nil {
		if observer, ok := executor.(interface {
			WaitUntilExecuting(context.Context, string) error
		}); ok {
			waitUntilExecuting = observer.WaitUntilExecuting
		}
	}
	if waitUntilExecuting == nil {
		t.Fatalf("cancellation fixture lacks an execution-start observer")
	}
	requireStillExecuting := func(label string) {
		stillActiveContext, stopStillActive := context.WithTimeout(context.Background(), 100*time.Millisecond)
		defer stopStillActive()
		if err := waitUntilExecuting(stillActiveContext, request.ExecutionID); err != nil {
			t.Fatalf("%s changed execution ownership state: %v", label, err)
		}
		select {
		case executionErr := <-result:
			t.Fatalf("%s stopped the protected execution: %v", label, executionErr)
		case <-time.After(10 * time.Millisecond):
		}
	}
	waitContext, stopWaiting := context.WithTimeout(context.Background(), 2*time.Second)
	defer stopWaiting()
	if err := waitUntilExecuting(waitContext, request.ExecutionID); err != nil {
		t.Fatalf("blocking execution did not become cancellable: %v", err)
	}
	select {
	case executionErr := <-result:
		t.Fatalf("blocking execution completed before cancellation: %v", executionErr)
	default:
	}

	wrongID := fixture.Grant
	wrongID.ID += "-other"
	wrongIDRequest := runtimebackend.CancelRequest{Grant: wrongID, ExecutionID: request.ExecutionID}
	if err := canceller.Cancel(context.Background(), wrongIDRequest); !errors.Is(err, runtimebackend.ErrGrantMismatch) {
		t.Fatalf("cross-grant cancellation was accepted: %v", err)
	}
	requireStillExecuting("cross-grant cancellation refusal")

	wrongPolicy := fixture.Grant
	wrongPolicy.PolicyRevision++
	if err := canceller.Cancel(context.Background(), runtimebackend.CancelRequest{
		Grant: wrongPolicy, ExecutionID: request.ExecutionID,
	}); !errors.Is(err, runtimebackend.ErrGrantMismatch) {
		t.Fatalf("cross-policy cancellation was accepted: %v", err)
	}
	requireStillExecuting("cross-policy cancellation refusal")

	wrongTrafficClass := fixture.Grant
	if wrongTrafficClass.TrafficClass == runtimebackend.TrafficClassShadow {
		wrongTrafficClass.TrafficClass = runtimebackend.TrafficClassCustomer
	} else {
		wrongTrafficClass.TrafficClass = runtimebackend.TrafficClassShadow
	}
	if err := canceller.Cancel(context.Background(), runtimebackend.CancelRequest{
		Grant: wrongTrafficClass, ExecutionID: request.ExecutionID,
	}); !errors.Is(err, runtimebackend.ErrGrantMismatch) {
		t.Fatalf("cross-traffic-class cancellation was accepted: %v", err)
	}
	requireStillExecuting("cross-traffic-class cancellation refusal")
	if err := canceller.Cancel(context.Background(), runtimebackend.CancelRequest{
		Grant: fixture.Grant, ExecutionID: request.ExecutionID,
	}); err != nil {
		t.Fatalf("owner cancellation failed: %v", err)
	}
	select {
	case err := <-result:
		if !errors.Is(err, runtimebackend.ErrCancelled) {
			t.Fatalf("cancelled execution returned wrong error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("owner cancellation did not stop execution")
	}
}

type failureInjector interface {
	FailNext(error) error
}

type executionObserver interface {
	WaitUntilExecuting(context.Context, string) error
}

func runFailureAndRestartChecks(
	t TestingT,
	backend runtimebackend.Backend,
	injector failureInjector,
	fixture Fixture,
	downloaded runtimebackend.DownloadedModel,
) {
	t.Helper()
	executor, ok := backend.(runtimebackend.Executor)
	if !ok {
		t.Fatalf("failure-injectable backend lacks Executor")
	}
	request := runtimebackend.ExecutionRequest{
		Grant: fixture.Grant, ExecutionID: "contract-crash", ModelID: fixture.Model.ID,
		TrafficClass: fixture.Grant.TrafficClass, Input: append([]byte{}, fixture.Input...),
		MaximumOutputBytes: uint64(len(fixture.Input)),
	}
	if err := injector.FailNext(runtimebackend.ErrCrashed); err != nil {
		t.Fatalf("inject crash: %v", err)
	}
	if _, err := executor.Execute(context.Background(), request); !errors.Is(err, runtimebackend.ErrCrashed) {
		t.Fatalf("crash was not classified: %v", err)
	}
	health, err := backend.Health(context.Background(), fixture.Grant)
	if err != nil || health.Running {
		t.Fatalf("backend remained healthy after crash: %#v %v", health, err)
	}
	readiness, err := backend.Ready(context.Background(), fixture.Grant)
	if err != nil || readiness.Ready {
		t.Fatalf("backend remained ready after crash: %#v %v", readiness, err)
	}
	if _, err := backend.Prepare(context.Background(), fixture.Grant); err != nil {
		t.Fatalf("prepare after crash: %v", err)
	}
	if _, err := backend.Start(context.Background(), fixture.Grant); err != nil {
		t.Fatalf("start after crash: %v", err)
	}
	if _, err := backend.Load(context.Background(), runtimebackend.LoadRequest{Grant: fixture.Grant, Model: fixture.Model, Download: downloaded}); err != nil {
		t.Fatalf("load after crash: %v", err)
	}
	readiness, err = backend.Ready(context.Background(), fixture.Grant)
	if err != nil || !readiness.Ready {
		t.Fatalf("backend did not recover readiness: %#v %v", readiness, err)
	}
	for index, failure := range []error{runtimebackend.ErrTimedOut, runtimebackend.ErrCancelled} {
		if err := injector.FailNext(failure); err != nil {
			t.Fatalf("inject normalized failure: %v", err)
		}
		request.ExecutionID = "contract-failure-" + string(rune('a'+index))
		if _, err := executor.Execute(context.Background(), request); !errors.Is(err, failure) {
			t.Fatalf("failure %v was not preserved: %v", failure, err)
		}
	}
	metrics, err := backend.Metrics(context.Background(), fixture.Grant)
	if err != nil || metrics.CrashErrors == 0 || metrics.TimeoutErrors == 0 || metrics.CancelledExecutions == 0 {
		t.Fatalf("failure metrics were not normalized: %#v %v", metrics, err)
	}
}
