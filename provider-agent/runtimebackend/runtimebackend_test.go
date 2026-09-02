package runtimebackend_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/thibautrey/multivibe/provider-agent/runtimebackend"
	"github.com/thibautrey/multivibe/provider-agent/runtimebackend/contracttest"
)

var fixedNow = time.Now().UTC().Truncate(time.Second)

func TestContractSuiteAgainstGPUFreeFake(t *testing.T) {
	descriptor := contracttest.DefaultDescriptor("contract-fake")
	fake, err := contracttest.NewFake(descriptor, contracttest.WithClock(func() time.Time { return fixedNow }))
	if err != nil {
		t.Fatal(err)
	}
	contracttest.Run(t, fake, contracttest.DefaultFixture(fixedNow))
}

func TestDescriptorAndGrantDoNotExposeLaunchMaterial(t *testing.T) {
	descriptor := contracttest.DefaultDescriptor("safe-descriptor")
	typeOfDescriptor := reflect.TypeOf(descriptor)
	for _, forbidden := range []string{"Launch", "Executable", "Argv", "Arguments", "Environment", "DeviceID", "Path"} {
		if _, found := typeOfDescriptor.FieldByName(forbidden); found {
			t.Fatalf("public descriptor exposes %s", forbidden)
		}
	}
	raw, err := json.Marshal(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	serialized := string(raw)
	for _, forbidden := range []string{"launch", "executable", "argv", "environment", "device_id", "local_path"} {
		if strings.Contains(serialized, forbidden) {
			t.Fatalf("descriptor serialization exposes %q: %s", forbidden, serialized)
		}
	}
	grant := testGrant()
	grantJSON, err := json.Marshal(grant)
	if err != nil || string(grantJSON) != "{}" {
		t.Fatalf("operation grant became serializable: %s %v", grantJSON, err)
	}
}

func TestExecutionPayloadsAreRedactedFromSerializationAndFormatting(t *testing.T) {
	private := []byte("private-prompt-and-response-sentinel")
	fixture := contracttest.DefaultFixture(fixedNow)
	fixture.Input = private
	fixture.BlockingInput = private
	values := []any{
		runtimebackend.ExecutionRequest{
			ExecutionID: "redaction", ModelID: "hf:publisher/model", TrafficClass: runtimebackend.TrafficClassShadow,
			Input: private, MaximumOutputBytes: 64,
		},
		runtimebackend.ExecutionResult{Output: private},
		runtimebackend.ExecutionChunk{Event: runtimebackend.ExecutionEventOutput, Output: private, Final: true},
		fixture,
	}
	for _, value := range values {
		raw, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		formatted := fmt.Sprintf("%v %+v %#v", value, value, value)
		var logged bytes.Buffer
		log.New(&logged, "", 0).Printf("%v", value)
		if bytes.Contains(raw, private) || strings.Contains(string(raw), "cHJpdmF0ZS1wcm9tcHQtYW5kLXJlc3BvbnNlLXNlbnRpbmVs") ||
			strings.Contains(formatted, string(private)) || strings.Contains(logged.String(), string(private)) {
			t.Fatalf("execution payload escaped redaction: json=%s formatted=%s log=%s", raw, formatted, logged.String())
		}
	}
}

func TestRegistryRejectsAdvertisedInterfaceThatIsMissing(t *testing.T) {
	fake := mustFake(t, "hidden-executor", 10)
	wrapped := &lifecycleOnlyBackend{backend: fake}
	if _, err := runtimebackend.NewRegistry(wrapped); !errors.Is(err, runtimebackend.ErrInvalid) {
		t.Fatalf("registry accepted execute capability without Executor: %v", err)
	}

	descriptor := contracttest.DefaultDescriptor("lifecycle-only")
	descriptor.Capabilities.Execute = false
	descriptor.Capabilities.Stream = false
	descriptor.Capabilities.Cancel = false
	lifecycleFake, err := contracttest.NewFake(descriptor, contracttest.WithClock(func() time.Time { return fixedNow }))
	if err != nil {
		t.Fatal(err)
	}
	lifecycleRegistry, err := runtimebackend.NewRegistry(&lifecycleOnlyBackend{backend: lifecycleFake})
	if err != nil {
		t.Fatalf("registry rejected a valid lifecycle-only backend: %v", err)
	}
	lifecycleBackend, found := lifecycleRegistry.Backend("lifecycle-only")
	if !found {
		t.Fatal("registered lifecycle-only backend is missing")
	}
	if _, exposed := lifecycleBackend.(runtimebackend.Executor); exposed {
		t.Fatal("registry wrapper exposed an undeclared execution interface")
	}
}

func TestRegistryEnforcesExecutionTrafficClass(t *testing.T) {
	shadow := mustFake(t, "traffic-shadow", 10)
	fixture := prepareFake(t, shadow, runtimebackend.TrafficClassShadow)
	registry, err := runtimebackend.NewRegistry(shadow)
	if err != nil {
		t.Fatal(err)
	}
	executor, ok := registry.Executor("traffic-shadow")
	if !ok {
		t.Fatal("shadow executor is unavailable")
	}
	request := runtimebackend.ExecutionRequest{
		Grant: fixture.Grant, ExecutionID: "shadow-allowed", ModelID: fixture.Model.ID,
		TrafficClass: runtimebackend.TrafficClassShadow, Input: []byte("probe"), MaximumOutputBytes: 5,
	}
	result, err := executor.Execute(context.Background(), request)
	if err != nil || string(result.Output) != "probe" {
		t.Fatalf("shadow traffic was rejected: output_bytes=%d err=%v", len(result.Output), err)
	}
	metricsBefore, err := shadow.Metrics(context.Background(), fixture.Grant)
	if err != nil {
		t.Fatal(err)
	}

	mismatch := request
	mismatch.ExecutionID = "class-mismatch"
	mismatch.TrafficClass = runtimebackend.TrafficClassCustomer
	if err := runtimebackend.ValidateExecutionRequest(mismatch, fixedNow); !errors.Is(err, runtimebackend.ErrInvalid) {
		t.Fatalf("execution validator accepted a class not authorized by the grant: %v", err)
	}
	if _, err := executor.Execute(context.Background(), mismatch); !errors.Is(err, runtimebackend.ErrInvalid) {
		t.Fatalf("registry accepted a class not authorized by the grant: %v", err)
	}

	zeroGrant := request.Grant
	zeroGrant.TrafficClass = ""
	if err := runtimebackend.ValidateOperationGrant(zeroGrant, fixedNow); !errors.Is(err, runtimebackend.ErrInvalid) {
		t.Fatalf("grant without a traffic class was accepted: %v", err)
	}

	customerRequest := request
	customerRequest.ExecutionID = "customer-rejected"
	customerRequest.Grant.TrafficClass = runtimebackend.TrafficClassCustomer
	customerRequest.TrafficClass = runtimebackend.TrafficClassCustomer
	if _, err := executor.Execute(context.Background(), customerRequest); !errors.Is(err, runtimebackend.ErrExecutionDisabled) {
		t.Fatalf("registry accepted a customer grant for shadow-only backend: %v", err)
	}
	streamer, ok := registry.StreamExecutor("traffic-shadow")
	if !ok {
		t.Fatal("shadow stream executor is unavailable")
	}
	emitted := false
	customerRequest.ExecutionID = "customer-stream-rejected"
	if _, err := streamer.ExecuteStream(context.Background(), customerRequest, func(runtimebackend.ExecutionChunk) error {
		emitted = true
		return nil
	}); !errors.Is(err, runtimebackend.ErrExecutionDisabled) || emitted {
		t.Fatalf("registry streamed customer traffic for shadow-only backend: emitted=%t err=%v", emitted, err)
	}
	selection, err := registry.Select(testSelectionRequest(shadow))
	if err != nil {
		t.Fatal(err)
	}
	selectedExecutor, ok := selection.Primary.(runtimebackend.Executor)
	if !ok {
		t.Fatal("selected backend lost its advertised executor")
	}
	customerRequest.ExecutionID = "selected-customer-rejected"
	if _, err := selectedExecutor.Execute(context.Background(), customerRequest); !errors.Is(err, runtimebackend.ErrExecutionDisabled) {
		t.Fatalf("selected backend bypassed customer-traffic policy: %v", err)
	}
	customerSelection := testSelectionRequest(shadow)
	customerSelection.Grant.TrafficClass = runtimebackend.TrafficClassCustomer
	if _, err := registry.Select(customerSelection); !errors.Is(err, runtimebackend.ErrInvalid) {
		t.Fatalf("selection accepted a customer grant without a matching capability request: %v", err)
	}
	customerSelection.RequiredCapabilities.CustomerTraffic = true
	rejectedSelection, err := registry.Select(customerSelection)
	if !errors.Is(err, runtimebackend.ErrIncompatible) || rejectedSelection.Primary != nil ||
		!candidateReason(rejectedSelection.Explanation, "traffic-shadow", runtimebackend.ReasonCustomerTrafficForbidden) {
		t.Fatalf("selection accepted customer traffic for shadow-only backend: %#v err=%v", rejectedSelection.Explanation, err)
	}
	metricsAfter, err := shadow.Metrics(context.Background(), fixture.Grant)
	if err != nil || metricsAfter.ExecutionSamples != metricsBefore.ExecutionSamples {
		t.Fatalf("rejected traffic reached the backend: before=%d after=%d err=%v",
			metricsBefore.ExecutionSamples, metricsAfter.ExecutionSamples, err)
	}

	request.ExecutionID = "missing-class"
	request.TrafficClass = ""
	if err := runtimebackend.ValidateExecutionRequest(request, fixedNow); !errors.Is(err, runtimebackend.ErrInvalid) {
		t.Fatalf("missing traffic class was accepted: %v", err)
	}
	if _, err := executor.Execute(context.Background(), request); !errors.Is(err, runtimebackend.ErrInvalid) {
		t.Fatalf("registry accepted a missing traffic class: %v", err)
	}
}

func TestCustomerCapableBackendAcceptsExplicitCustomerTraffic(t *testing.T) {
	descriptor := contracttest.DefaultDescriptor("traffic-customer")
	descriptor.Capabilities.ShadowOnly = false
	descriptor.Capabilities.CustomerTraffic = true
	backend, err := contracttest.NewFake(descriptor, contracttest.WithClock(func() time.Time { return fixedNow }))
	if err != nil {
		t.Fatal(err)
	}
	fixture := prepareFake(t, backend, runtimebackend.TrafficClassCustomer)
	registry, err := runtimebackend.NewRegistry(backend)
	if err != nil {
		t.Fatal(err)
	}
	selectionRequest := testSelectionRequest(backend)
	selectionRequest.Grant.TrafficClass = runtimebackend.TrafficClassCustomer
	selectionRequest.RequiredCapabilities.CustomerTraffic = true
	selection, err := registry.Select(selectionRequest)
	if err != nil {
		t.Fatalf("selection lost the customer traffic class while cloning the grant: %v", err)
	}
	executor, ok := selection.Primary.(runtimebackend.Executor)
	if !ok {
		t.Fatal("customer-capable executor is unavailable")
	}
	request := runtimebackend.ExecutionRequest{
		Grant: fixture.Grant, ExecutionID: "customer-allowed", ModelID: fixture.Model.ID,
		TrafficClass: runtimebackend.TrafficClassCustomer, Input: []byte("probe"), MaximumOutputBytes: 5,
	}
	result, err := executor.Execute(context.Background(), request)
	if err != nil || string(result.Output) != "probe" {
		t.Fatalf("explicit customer traffic was rejected: output_bytes=%d err=%v", len(result.Output), err)
	}
}

func TestRegistryRejectsOppositeTrafficClassCancellationBeforeBackend(t *testing.T) {
	fake := mustFake(t, "cancel-traffic-owner", 10)
	fixture := prepareFake(t, fake, runtimebackend.TrafficClassShadow)
	counting := &cancelCountingBackend{Fake: fake}
	registry, err := runtimebackend.NewRegistry(counting)
	if err != nil {
		t.Fatal(err)
	}
	executor, executeOK := registry.Executor("cancel-traffic-owner")
	canceller, cancelOK := registry.Canceller("cancel-traffic-owner")
	if !executeOK || !cancelOK {
		t.Fatal("cancellation-capable backend lost an advertised interface")
	}
	request := runtimebackend.ExecutionRequest{
		Grant: fixture.Grant, ExecutionID: "cancel-class-owner", ModelID: fixture.Model.ID,
		TrafficClass: runtimebackend.TrafficClassShadow, Input: []byte(contracttest.BlockingInput),
		MaximumOutputBytes: uint64(len(contracttest.BlockingInput)),
	}
	result := make(chan error, 1)
	executionContext, stopExecution := context.WithTimeout(context.Background(), 2*time.Second)
	defer stopExecution()
	go func() {
		_, executeErr := executor.Execute(executionContext, request)
		result <- executeErr
	}()
	waitContext, stopWaiting := context.WithTimeout(context.Background(), time.Second)
	defer stopWaiting()
	if err := fake.WaitUntilExecuting(waitContext, request.ExecutionID); err != nil {
		t.Fatalf("blocking execution did not start: %v", err)
	}

	opposite := fixture.Grant
	opposite.TrafficClass = runtimebackend.TrafficClassCustomer
	if err := canceller.Cancel(context.Background(), runtimebackend.CancelRequest{
		Grant: opposite, ExecutionID: request.ExecutionID,
	}); !errors.Is(err, runtimebackend.ErrGrantMismatch) {
		t.Fatalf("opposite-class cancellation was accepted: %v", err)
	}
	if counting.cancelCalls.Load() != 0 {
		t.Fatalf("opposite-class cancellation reached the backend: calls=%d", counting.cancelCalls.Load())
	}
	stillActiveContext, stopStillActive := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer stopStillActive()
	if err := fake.WaitUntilExecuting(stillActiveContext, request.ExecutionID); err != nil {
		t.Fatalf("opposite-class refusal changed active ownership: %v", err)
	}
	select {
	case executeErr := <-result:
		t.Fatalf("opposite-class refusal stopped the execution: %v", executeErr)
	case <-time.After(10 * time.Millisecond):
	}

	if err := canceller.Cancel(context.Background(), runtimebackend.CancelRequest{
		Grant: fixture.Grant, ExecutionID: request.ExecutionID,
	}); err != nil {
		t.Fatalf("owner cancellation failed: %v", err)
	}
	if counting.cancelCalls.Load() != 1 {
		t.Fatalf("owner cancellation did not reach the backend exactly once: calls=%d", counting.cancelCalls.Load())
	}
	select {
	case executeErr := <-result:
		if !errors.Is(executeErr, runtimebackend.ErrCancelled) {
			t.Fatalf("owner cancellation returned the wrong execution error: %v", executeErr)
		}
	case <-time.After(time.Second):
		t.Fatal("owner cancellation did not stop the execution")
	}
}

func TestModelReceiptsAndCleanupAreGrantTrafficAndDigestOwned(t *testing.T) {
	fake := mustFake(t, "model-ownership", 10)
	fixture := contracttest.DefaultFixture(fixedNow)
	ctx := context.Background()
	if _, err := fake.Prepare(ctx, fixture.Grant); err != nil {
		t.Fatal(err)
	}
	firstReceipt, err := fake.Download(ctx, runtimebackend.DownloadRequest{Grant: fixture.Grant, Model: fixture.Model})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fake.Start(ctx, fixture.Grant); err != nil {
		t.Fatal(err)
	}

	oppositeClass := fixture.Grant
	oppositeClass.TrafficClass = runtimebackend.TrafficClassCustomer
	if _, err := fake.Load(ctx, runtimebackend.LoadRequest{
		Grant: oppositeClass, Model: fixture.Model, Download: firstReceipt,
	}); !errors.Is(err, runtimebackend.ErrGrantMismatch) {
		t.Fatalf("opposite-class grant reused a download receipt: %v", err)
	}
	if err := fake.Cleanup(ctx, runtimebackend.CleanupRequest{
		Grant: oppositeClass, ModelIDs: []string{fixture.Model.ID},
	}); !errors.Is(err, runtimebackend.ErrGrantMismatch) {
		t.Fatalf("opposite-class cleanup was accepted: %v", err)
	}
	if _, err := fake.Load(ctx, runtimebackend.LoadRequest{
		Grant: fixture.Grant, Model: fixture.Model, Download: firstReceipt,
	}); err != nil {
		t.Fatalf("owner could not load its receipt after refused cleanup: %v", err)
	}

	secondModel := fixture.Model
	secondModel.ContentDigest = "sha256:" + strings.Repeat("c", 64)
	otherGrant := fixture.Grant
	otherGrant.ID += "-other"
	otherReceipt, err := fake.Download(ctx, runtimebackend.DownloadRequest{Grant: otherGrant, Model: secondModel})
	if err != nil {
		t.Fatal(err)
	}
	if err := fake.Cleanup(ctx, runtimebackend.CleanupRequest{
		Grant: fixture.Grant, ModelIDs: []string{fixture.Model.ID}, StopRuntime: true,
	}); !errors.Is(err, runtimebackend.ErrGrantMismatch) {
		t.Fatalf("owner cleanup stopped a runtime with another owner's receipt: %v", err)
	}
	ready, err := fake.Ready(ctx, fixture.Grant)
	if err != nil || !ready.Ready {
		t.Fatalf("refused stop mutated the owner's loaded model: %#v err=%v", ready, err)
	}

	secondReceipt, err := fake.Download(ctx, runtimebackend.DownloadRequest{Grant: fixture.Grant, Model: secondModel})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fake.Load(ctx, runtimebackend.LoadRequest{
		Grant: fixture.Grant, Model: secondModel, Download: secondReceipt,
	}); err != nil {
		t.Fatalf("second digest was not independently loadable: %v", err)
	}
	if _, err := fake.Execute(ctx, runtimebackend.ExecutionRequest{
		Grant: fixture.Grant, ExecutionID: "ambiguous-digest", ModelID: fixture.Model.ID,
		TrafficClass: fixture.Grant.TrafficClass, Input: []byte("probe"), MaximumOutputBytes: 5,
	}); !errors.Is(err, runtimebackend.ErrInvalid) {
		t.Fatalf("execution chose an ambiguous loaded digest: %v", err)
	}

	if err := fake.Cleanup(ctx, runtimebackend.CleanupRequest{
		Grant: fixture.Grant, ModelIDs: []string{fixture.Model.ID},
	}); err != nil {
		t.Fatalf("owner cleanup failed: %v", err)
	}
	ready, err = fake.Ready(ctx, fixture.Grant)
	if err != nil || ready.Ready {
		t.Fatalf("owner models remained ready after cleanup: %#v err=%v", ready, err)
	}
	if _, err := fake.Load(ctx, runtimebackend.LoadRequest{
		Grant: otherGrant, Model: secondModel, Download: otherReceipt,
	}); err != nil {
		t.Fatalf("owner cleanup removed another grant's receipt: %v", err)
	}
}

func TestRegistrySnapshotsMutableDescriptorData(t *testing.T) {
	fake := mustFake(t, "immutable", 10)
	registry, err := runtimebackend.NewRegistry(fake)
	if err != nil {
		t.Fatal(err)
	}
	first, _ := registry.Descriptor("immutable")
	first.Accelerators[0].Profile = "mutated"
	first.Provenance.ArtifactSHA256["linux-amd64"] = strings.Repeat("f", 64)
	second, _ := registry.Descriptor("immutable")
	if second.Accelerators[0].Profile == "mutated" || second.Provenance.ArtifactSHA256["linux-amd64"] == strings.Repeat("f", 64) {
		t.Fatal("registry descriptor snapshot was externally mutable")
	}
	ids := registry.IDs()
	ids[0] = "mutated"
	if !reflect.DeepEqual(registry.IDs(), []string{"immutable"}) {
		t.Fatal("registry IDs were externally mutable")
	}
}

func TestSelectionModesAreDeterministicAndConservative(t *testing.T) {
	alpha := mustFake(t, "alpha", 20)
	beta := mustFake(t, "beta", 10)
	gamma := mustFake(t, "gamma", 10)
	registry, err := runtimebackend.NewRegistry(gamma, alpha, beta)
	if err != nil {
		t.Fatal(err)
	}
	request := testSelectionRequest(alpha, beta, gamma)
	auto, err := registry.Select(request)
	if err != nil || auto.Primary.Descriptor().ID != "beta" || len(auto.Fallbacks) != 0 || auto.Explanation.PrimaryBackendID != "beta" {
		t.Fatalf("auto selection mismatch: %#v %v", auto.Explanation, err)
	}
	baseline, _ := json.Marshal(auto.Explanation)
	for index := 0; index < 100; index++ {
		selected, selectErr := registry.Select(request)
		encoded, _ := json.Marshal(selected.Explanation)
		if selectErr != nil || string(encoded) != string(baseline) {
			t.Fatalf("selection changed at iteration %d: %s != %s (%v)", index, encoded, baseline, selectErr)
		}
	}

	request.Mode = runtimebackend.SelectionPrefer
	request.BackendIDs = []string{"gamma", "alpha"}
	preferred, err := registry.Select(request)
	if err != nil || preferred.Primary.Descriptor().ID != "gamma" || backendIDs(preferred.Fallbacks) != "alpha" ||
		!reflect.DeepEqual(preferred.Explanation.FallbackBackendIDs, []string{"alpha"}) {
		t.Fatalf("prefer selection mismatch: %#v %v", preferred.Explanation, err)
	}
	if candidateReason(preferred.Explanation, "beta", runtimebackend.ReasonNotPreferred) == false {
		t.Fatalf("unlisted candidate lacks conservative explanation: %#v", preferred.Explanation)
	}

	request.Mode = runtimebackend.SelectionRequire
	request.BackendIDs = []string{"alpha"}
	required, err := registry.Select(request)
	if err != nil || required.Primary.Descriptor().ID != "alpha" || len(required.Fallbacks) != 0 {
		t.Fatalf("require selection mismatch: %#v %v", required.Explanation, err)
	}
}

func TestSelectionFailsClosedWithStableReasons(t *testing.T) {
	fake := mustFake(t, "only", 10)
	registry, err := runtimebackend.NewRegistry(fake)
	if err != nil {
		t.Fatal(err)
	}
	request := testSelectionRequest(fake)
	request.Accelerator.Kind = "rocm"
	selection, err := registry.Select(request)
	if !errors.Is(err, runtimebackend.ErrIncompatible) || selection.Primary != nil ||
		!candidateReason(selection.Explanation, "only", runtimebackend.ReasonAcceleratorMismatch) {
		t.Fatalf("incompatible hardware did not fail closed: %#v %v", selection.Explanation, err)
	}

	request = testSelectionRequest(fake)
	request.AllowedBackends[0].Provenance.Version = "downgraded"
	selection, err = registry.Select(request)
	if !errors.Is(err, runtimebackend.ErrIncompatible) || !candidateReason(selection.Explanation, "only", runtimebackend.ReasonProvenanceMismatch) {
		t.Fatalf("provenance mismatch did not fail closed: %#v %v", selection.Explanation, err)
	}

	request = testSelectionRequest(fake)
	request.Grant.IssuedAt = fixedNow.Add(-2 * time.Hour)
	request.Grant.ExpiresAt = fixedNow.Add(-time.Hour)
	if _, err := registry.Select(request); !errors.Is(err, runtimebackend.ErrGrantExpired) {
		t.Fatalf("expired grant classification lost: %v", err)
	}

	rejecting := &rejectingBackend{Fake: mustFake(t, "private-reject", 10)}
	rejectingRegistry, err := runtimebackend.NewRegistry(rejecting)
	if err != nil {
		t.Fatal(err)
	}
	selection, err = rejectingRegistry.Select(testSelectionRequest(rejecting))
	if !errors.Is(err, runtimebackend.ErrIncompatible) ||
		!candidateReason(selection.Explanation, "private-reject", runtimebackend.ReasonBackendRejected) {
		t.Fatalf("backend private rejection was ignored or leaked: %#v %v", selection.Explanation, err)
	}

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := registry.SelectContext(cancelled, testSelectionRequest(fake)); !errors.Is(err, runtimebackend.ErrCancelled) {
		t.Fatalf("selection cancellation was not normalized: %v", err)
	}
}

func TestAdversarialDescriptorsAndRequests(t *testing.T) {
	base := contracttest.DefaultDescriptor("adversarial")
	tests := map[string]func(*runtimebackend.Descriptor){
		"stream without execute": func(value *runtimebackend.Descriptor) {
			value.Capabilities.Execute = false
		},
		"customer traffic in shadow": func(value *runtimebackend.Descriptor) {
			value.Capabilities.CustomerTraffic = true
		},
		"unsorted accelerators": func(value *runtimebackend.Descriptor) {
			value.Accelerators[0], value.Accelerators[1] = value.Accelerators[1], value.Accelerators[0]
		},
		"unpinned image": func(value *runtimebackend.Descriptor) {
			value.Provenance.ArtifactSHA256 = map[string]string{}
			value.Provenance.ContainerImages = []string{"registry.example.test/runtime:latest"}
		},
		"provenance query": func(value *runtimebackend.Descriptor) {
			value.Provenance.SourceURL += "?latest=true"
		},
		"zero output bound": func(value *runtimebackend.Descriptor) {
			value.Limits.MaximumOutputBytes = 0
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			probe := base
			probe.Accelerators = append([]runtimebackend.AcceleratorConstraint{}, base.Accelerators...)
			probe.Provenance.ArtifactSHA256 = map[string]string{"linux-amd64": strings.Repeat("a", 64)}
			mutate(&probe)
			if runtimebackend.ValidateDescriptor(probe) == nil {
				t.Fatalf("unsafe descriptor accepted: %#v", probe)
			}
		})
	}

	grant := testGrant()
	request := runtimebackend.ExecutionRequest{
		Grant: grant, ExecutionID: "valid", ModelID: grant.AllowedModelIDs[0], TrafficClass: runtimebackend.TrafficClassShadow,
		Input: []byte("probe"), MaximumOutputBytes: 1,
	}
	request.ExecutionID = "bad id"
	if err := runtimebackend.ValidateExecutionRequest(request, fixedNow); !errors.Is(err, runtimebackend.ErrInvalid) {
		t.Fatalf("unsafe execution ID accepted: %v", err)
	}
	request.ExecutionID = "valid"
	request.MaximumOutputBytes = grant.Limits.MaximumOutputBytes + 1
	if err := runtimebackend.ValidateExecutionRequest(request, fixedNow); !errors.Is(err, runtimebackend.ErrInvalid) {
		t.Fatalf("oversized output accepted: %v", err)
	}
}

func TestConcurrentSelectionAndFakeExecution(t *testing.T) {
	fake := mustFake(t, "race-fake", 10)
	registry, err := runtimebackend.NewRegistry(fake)
	if err != nil {
		t.Fatal(err)
	}
	fixture := contracttest.DefaultFixture(fixedNow)
	ctx := context.Background()
	if _, err := fake.Prepare(ctx, fixture.Grant); err != nil {
		t.Fatal(err)
	}
	download, err := fake.Download(ctx, runtimebackend.DownloadRequest{Grant: fixture.Grant, Model: fixture.Model})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fake.Start(ctx, fixture.Grant); err != nil {
		t.Fatal(err)
	}
	if _, err := fake.Load(ctx, runtimebackend.LoadRequest{Grant: fixture.Grant, Model: fixture.Model, Download: download}); err != nil {
		t.Fatal(err)
	}
	selectionRequest := testSelectionRequest(fake)
	const workers = 16
	const iterations = 50
	var wait sync.WaitGroup
	errorsSeen := make(chan error, workers*iterations*2)
	for worker := 0; worker < workers; worker++ {
		worker := worker
		wait.Add(1)
		go func() {
			defer wait.Done()
			for iteration := 0; iteration < iterations; iteration++ {
				if _, selectErr := registry.Select(selectionRequest); selectErr != nil {
					errorsSeen <- selectErr
				}
				_, executeErr := fake.Execute(ctx, runtimebackend.ExecutionRequest{
					Grant: fixture.Grant, ExecutionID: executionID(worker, iteration), ModelID: fixture.Model.ID,
					TrafficClass: runtimebackend.TrafficClassShadow, Input: []byte("x"), MaximumOutputBytes: 1,
				})
				if executeErr != nil {
					errorsSeen <- executeErr
				}
			}
		}()
	}
	wait.Wait()
	close(errorsSeen)
	for err := range errorsSeen {
		t.Errorf("concurrent operation failed: %v", err)
	}
	metrics, err := fake.Metrics(ctx, fixture.Grant)
	if err != nil || metrics.ExecutionSamples != workers*iterations || metrics.InFlight != 0 || runtimebackend.ValidateMetrics(fake.Descriptor(), metrics) != nil {
		t.Fatalf("concurrent metrics mismatch: %#v %v", metrics, err)
	}
}

func TestExecutionErrorNormalization(t *testing.T) {
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if !errors.Is(runtimebackend.NormalizeExecutionError(cancelled.Err()), runtimebackend.ErrCancelled) {
		t.Fatal("context cancellation was not normalized")
	}
	deadline, deadlineCancel := context.WithDeadline(context.Background(), fixedNow.Add(-time.Second))
	defer deadlineCancel()
	if !errors.Is(runtimebackend.NormalizeExecutionError(deadline.Err()), runtimebackend.ErrTimedOut) {
		t.Fatal("context deadline was not normalized")
	}
}

type lifecycleOnlyBackend struct {
	backend runtimebackend.Backend
}

type rejectingBackend struct {
	*contracttest.Fake
}

type cancelCountingBackend struct {
	*contracttest.Fake
	cancelCalls atomic.Uint64
}

func (backend *cancelCountingBackend) Cancel(ctx context.Context, request runtimebackend.CancelRequest) error {
	backend.cancelCalls.Add(1)
	return backend.Fake.Cancel(ctx, request)
}

func (backend *rejectingBackend) Compatible(context.Context, runtimebackend.CompatibilityRequest) (runtimebackend.Compatibility, error) {
	return runtimebackend.Compatibility{Compatible: false, Reasons: []runtimebackend.ReasonCode{runtimebackend.ReasonBackendRejected}}, nil
}

func (backend *lifecycleOnlyBackend) Descriptor() runtimebackend.Descriptor {
	return backend.backend.Descriptor()
}

func (backend *lifecycleOnlyBackend) Discover(ctx context.Context, grant runtimebackend.OperationGrant) (runtimebackend.Discovery, error) {
	return backend.backend.Discover(ctx, grant)
}

func (backend *lifecycleOnlyBackend) Compatible(ctx context.Context, request runtimebackend.CompatibilityRequest) (runtimebackend.Compatibility, error) {
	return backend.backend.Compatible(ctx, request)
}

func (backend *lifecycleOnlyBackend) Prepare(ctx context.Context, grant runtimebackend.OperationGrant) (runtimebackend.Health, error) {
	return backend.backend.Prepare(ctx, grant)
}

func (backend *lifecycleOnlyBackend) Download(ctx context.Context, request runtimebackend.DownloadRequest) (runtimebackend.DownloadedModel, error) {
	return backend.backend.Download(ctx, request)
}

func (backend *lifecycleOnlyBackend) Start(ctx context.Context, grant runtimebackend.OperationGrant) (runtimebackend.Health, error) {
	return backend.backend.Start(ctx, grant)
}

func (backend *lifecycleOnlyBackend) Load(ctx context.Context, request runtimebackend.LoadRequest) (runtimebackend.LoadedModel, error) {
	return backend.backend.Load(ctx, request)
}

func (backend *lifecycleOnlyBackend) Health(ctx context.Context, grant runtimebackend.OperationGrant) (runtimebackend.Health, error) {
	return backend.backend.Health(ctx, grant)
}

func (backend *lifecycleOnlyBackend) Ready(ctx context.Context, grant runtimebackend.OperationGrant) (runtimebackend.Readiness, error) {
	return backend.backend.Ready(ctx, grant)
}

func (backend *lifecycleOnlyBackend) Metrics(ctx context.Context, grant runtimebackend.OperationGrant) (runtimebackend.Metrics, error) {
	return backend.backend.Metrics(ctx, grant)
}

func (backend *lifecycleOnlyBackend) Cleanup(ctx context.Context, request runtimebackend.CleanupRequest) error {
	return backend.backend.Cleanup(ctx, request)
}

func (backend *lifecycleOnlyBackend) Stop(ctx context.Context, grant runtimebackend.OperationGrant) error {
	return backend.backend.Stop(ctx, grant)
}

func mustFake(t *testing.T, id string, priority uint16) *contracttest.Fake {
	t.Helper()
	descriptor := contracttest.DefaultDescriptor(id)
	descriptor.Priority = priority
	fake, err := contracttest.NewFake(descriptor, contracttest.WithClock(func() time.Time { return fixedNow }))
	if err != nil {
		t.Fatal(err)
	}
	return fake
}

func prepareFake(t *testing.T, fake *contracttest.Fake, trafficClass runtimebackend.TrafficClass) contracttest.Fixture {
	t.Helper()
	fixture := contracttest.DefaultFixture(fixedNow)
	fixture.Grant.TrafficClass = trafficClass
	ctx := context.Background()
	if _, err := fake.Prepare(ctx, fixture.Grant); err != nil {
		t.Fatal(err)
	}
	download, err := fake.Download(ctx, runtimebackend.DownloadRequest{Grant: fixture.Grant, Model: fixture.Model})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := fake.Start(ctx, fixture.Grant); err != nil {
		t.Fatal(err)
	}
	if _, err := fake.Load(ctx, runtimebackend.LoadRequest{Grant: fixture.Grant, Model: fixture.Model, Download: download}); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func testGrant() runtimebackend.OperationGrant {
	return runtimebackend.OperationGrant{
		ID: "selection-grant", PolicyRevision: 1, TrafficClass: runtimebackend.TrafficClassShadow,
		IssuedAt: fixedNow.Add(-time.Minute), ExpiresAt: fixedNow.Add(time.Hour),
		AllowedModelIDs: []string{"hf:example/model"},
		Limits: runtimebackend.Limits{
			MaximumModels: 2, MaximumConcurrency: 2, MaximumModelBytes: 1 << 30, MaximumMemoryBytes: 1 << 31,
			MaximumContextTokens: 8192, MaximumInputBytes: 1024, MaximumOutputBytes: 1024,
		},
	}
}

func testSelectionRequest(backends ...runtimebackend.Backend) runtimebackend.SelectionRequest {
	constraints := make([]runtimebackend.BackendConstraint, 0, len(backends))
	for _, backend := range backends {
		descriptor := backend.Descriptor()
		constraints = append(constraints, runtimebackend.BackendConstraint{BackendID: descriptor.ID, Provenance: descriptor.Provenance})
	}
	sortConstraints(constraints)
	grant := testGrant()
	return runtimebackend.SelectionRequest{
		Mode: runtimebackend.SelectionAuto, AllowedBackends: constraints,
		RequiredCapabilities: runtimebackend.CapabilityRequirements{Execute: true, Stream: true, Cancel: true},
		Accelerator:          runtimebackend.Accelerator{Profile: "linux-nvidia", OS: "linux", Architecture: "amd64", Kind: "cuda", MemoryBytes: 1 << 33},
		Model: runtimebackend.ModelRequirements{
			ID: grant.AllowedModelIDs[0], ContentDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			ArtifactBytes: 1 << 20, EstimatedMemoryBytes: 1 << 21, ContextTokens: 4096,
		},
		Grant: grant, EvaluationTime: fixedNow,
	}
}

func sortConstraints(constraints []runtimebackend.BackendConstraint) {
	for left := range constraints {
		for right := left + 1; right < len(constraints); right++ {
			if constraints[right].BackendID < constraints[left].BackendID {
				constraints[left], constraints[right] = constraints[right], constraints[left]
			}
		}
	}
}

func backendIDs(backends []runtimebackend.Backend) string {
	ids := make([]string, 0, len(backends))
	for _, backend := range backends {
		ids = append(ids, backend.Descriptor().ID)
	}
	return strings.Join(ids, ",")
}

func candidateReason(explanation runtimebackend.Explanation, backendID string, expected runtimebackend.ReasonCode) bool {
	for _, candidate := range explanation.Candidates {
		if candidate.BackendID != backendID {
			continue
		}
		for _, reason := range candidate.Reasons {
			if reason == expected {
				return true
			}
		}
	}
	return false
}

func executionID(worker, iteration int) string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	encode := func(value int) string {
		if value == 0 {
			return "0"
		}
		result := ""
		for value > 0 {
			result = string(alphabet[value%len(alphabet)]) + result
			value /= len(alphabet)
		}
		return result
	}
	return "race-" + encode(worker) + "-" + encode(iteration)
}
