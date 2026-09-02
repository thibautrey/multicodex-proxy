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
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"
)

type managedControllerTestRuntime struct {
	mu             sync.Mutex
	calls          []string
	installed      bool
	running        bool
	inventory      []string
	pullStarted    chan struct{}
	pullRelease    chan struct{}
	pullStartedOne sync.Once
	stopObserved   chan struct{}
	stopOne        sync.Once
}

func (runtime *managedControllerTestRuntime) record(call string) {
	runtime.mu.Lock()
	runtime.calls = append(runtime.calls, call)
	runtime.mu.Unlock()
}

func (runtime *managedControllerTestRuntime) ensureRuntime(ctx context.Context, _ *capacityPolicyStateDocument, _ string) (managedOllamaStatus, error) {
	runtime.record("install")
	select {
	case <-ctx.Done():
		return runtime.status(nil), ctx.Err()
	default:
	}
	runtime.mu.Lock()
	runtime.installed = true
	runtime.mu.Unlock()
	return runtime.status(nil), nil
}

func (runtime *managedControllerTestRuntime) start(ctx context.Context, _ *capacityPolicyStateDocument) (managedOllamaStatus, error) {
	runtime.record("start")
	select {
	case <-ctx.Done():
		return runtime.status(nil), ctx.Err()
	default:
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if !runtime.installed {
		return managedOllamaStatus{}, errManagedOllamaRuntimeMissing
	}
	runtime.running = true
	return runtime.statusLocked(), nil
}

func (runtime *managedControllerTestRuntime) stop(_ context.Context) error {
	runtime.record("stop")
	runtime.mu.Lock()
	runtime.running = false
	runtime.mu.Unlock()
	if runtime.stopObserved != nil {
		runtime.stopOne.Do(func() { close(runtime.stopObserved) })
	}
	return nil
}

func (runtime *managedControllerTestRuntime) enforcePolicy(ctx context.Context, policy *capacityPolicyStateDocument) error {
	runtime.record("enforce-policy")
	if policy == nil || policy.Paused == nil || *policy.Paused {
		return runtime.stop(ctx)
	}
	return nil
}

func (runtime *managedControllerTestRuntime) status(policy *capacityPolicyStateDocument) managedOllamaStatus {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	status := runtime.statusLocked()
	status.Paused = policy != nil && policy.Paused != nil && *policy.Paused
	return status
}

func (runtime *managedControllerTestRuntime) statusLocked() managedOllamaStatus {
	state := "stopped"
	if runtime.running {
		state = "running"
	}
	return managedOllamaStatus{
		SchemaVersion: "managed-ollama-status-v1", State: state, Version: managedOllamaVersion,
		Platform: "linux-amd64", RuntimeInstalled: runtime.installed, Running: runtime.running,
		InstalledModelIDs: append([]string{}, runtime.inventory...),
	}
}

func (runtime *managedControllerTestRuntime) pullModelResult(ctx context.Context, _ *capacityPolicyStateDocument, _ string, download plannedModelDownload) (managedOllamaModelRecord, bool, error) {
	runtime.record("pull:" + download.ModelID)
	if runtime.pullStarted != nil {
		runtime.pullStartedOne.Do(func() { close(runtime.pullStarted) })
	}
	if runtime.pullRelease != nil {
		select {
		case <-ctx.Done():
			return managedOllamaModelRecord{}, false, ctx.Err()
		case <-runtime.pullRelease:
		}
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	for _, modelID := range runtime.inventory {
		if modelID == download.ModelID {
			return managedControllerTestModelRecord(modelID), false, nil
		}
	}
	runtime.inventory = append(runtime.inventory, download.ModelID)
	sort.Strings(runtime.inventory)
	return managedControllerTestModelRecord(download.ModelID), true, nil
}

func (runtime *managedControllerTestRuntime) authorizeModelActivation(_ *capacityPolicyStateDocument, _ string, modelID string) (managedOllamaModelRecord, error) {
	runtime.record("authorize:" + modelID)
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	for _, installed := range runtime.inventory {
		if installed == modelID {
			return managedControllerTestModelRecord(modelID), nil
		}
	}
	return managedOllamaModelRecord{}, errors.New("not installed")
}

func (runtime *managedControllerTestRuntime) deactivateModel(_ context.Context, _ *capacityPolicyStateDocument, _ string, modelID string) error {
	runtime.record("deactivate:" + modelID)
	return nil
}

func (runtime *managedControllerTestRuntime) managedInventory(_ *capacityPolicyStateDocument) ([]string, error) {
	runtime.record("inventory")
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	return append([]string{}, runtime.inventory...), nil
}

func managedControllerTestModelRecord(modelID string) managedOllamaModelRecord {
	return managedOllamaModelRecord{
		CanonicalModelID: modelID, OllamaModel: "qwen2.5:0.5b",
		OllamaManifestPath: "registry.ollama.ai/library/qwen2.5/0.5b", ManifestSHA256: "sha256:" + strings.Repeat("a", 64),
	}
}

type managedControllerFixture struct {
	controller   *managedProviderController
	runtime      *managedControllerTestRuntime
	policy       *capacityPolicyStore
	plans        *providerDemandPlanStore
	plannerState *managedPlannerStateStore
	base         string
	now          time.Time
}

func newManagedControllerFixture(t *testing.T) managedControllerFixture {
	t.Helper()
	base := t.TempDir()
	now := time.Now().UTC().Truncate(time.Millisecond)
	storage := filepath.Join(base, "models")
	policyStore := newMemoryCapacityPolicyStore()
	policy := managedOllamaTestPolicy(storage, 1, false, true)
	policy.AllowCloudWorkloads = managedOllamaTestBool(true)
	input := *policy
	input.Revision = 0
	if _, conflict, err := policyStore.replace(0, input); err != nil || conflict {
		t.Fatalf("cannot create policy: conflict=%v err=%v", conflict, err)
	}
	plans := newMemoryProviderDemandPlanStore()
	manifestBytes := []byte(`{"schemaVersion":2,"layers":[]}`)
	catalogPath := writeManagedOllamaTestCatalog(t, base, "sha256:"+managedOllamaTestSHA(manifestBytes))
	dependencyPath := writeManagedOllamaTestDependencies(t, base, strings.Repeat("a", 64))
	plannerState, err := openManagedPlannerStateStore(filepath.Join(base, "planner-state.json"))
	if err != nil {
		t.Fatal(err)
	}
	runtime := &managedControllerTestRuntime{}
	controller, err := newManagedProviderController(
		runtime, policyStore, plans, plannerState, catalogPath, dependencyPath, filepath.Join(base, "controller-state.json"),
	)
	if err != nil {
		t.Fatal(err)
	}
	controller.now = func() time.Time { return now }
	return managedControllerFixture{
		controller: controller, runtime: runtime, policy: policyStore, plans: plans,
		plannerState: plannerState, base: base, now: now,
	}
}

func managedControllerTestPlan(generation uint64, digestCharacter string, now time.Time, selected []string, downloads []plannedModelDownload, changed bool) providerDemandPlanState {
	return providerDemandPlanState{
		SchemaVersion: providerDemandPlanStateSchemaVersion, Generation: generation,
		EnvelopeDigest: strings.Repeat(digestCharacter, 64), SigningKeyID: "ed25519:" + strings.Repeat("A", 43),
		AcceptedAt: canonicalPlannerTime(now.Add(-time.Second)), ExpiresAt: canonicalPlannerTime(now.Add(time.Minute)),
		Plan: modelPlan{
			SchemaVersion: modelPlanSchemaVersion, DemandRevision: generation, ModelStoragePath: "/unused-by-controller",
			SelectedModelIDs: append([]string{}, selected...), Downloads: append([]plannedModelDownload{}, downloads...),
			ModelChange: changed, Constraints: []modelPlanConstraint{},
		},
	}
}

func TestManagedControllerReconcilesLatestSignedPlanAndPersistsAccounting(t *testing.T) {
	fixture := newManagedControllerFixture(t)
	modelID := "hf:qwen/qwen2.5-0.5b-instruct"
	plan := managedControllerTestPlan(1, "a", fixture.now, []string{modelID}, []plannedModelDownload{{ModelID: modelID, Bytes: 16}}, true)
	if err := fixture.plans.commit(plan); err != nil {
		t.Fatal(err)
	}
	view, err := fixture.controller.reconcile(context.Background(), managedControllerFence{
		PolicyRevision: 1, PlanGeneration: 1, EnvelopeDigest: plan.EnvelopeDigest,
	})
	if err != nil {
		t.Fatal(err)
	}
	if view.State != "ready-shadow" || !view.ShadowOnly || view.CustomerTrafficAllowed || view.RoutingEligible || view.CompensationEligible {
		t.Fatalf("controller crossed its shadow-only boundary: %#v", view)
	}
	fixture.runtime.mu.Lock()
	calls := append([]string{}, fixture.runtime.calls...)
	fixture.runtime.mu.Unlock()
	wantOrder := []string{"inventory", "install", "start", "pull:" + modelID, "authorize:" + modelID}
	if !managedControllerCallsContainInOrder(calls, wantOrder) {
		t.Fatalf("unexpected reconciliation order: %v", calls)
	}
	planner, err := fixture.plannerState.plannerState([]string{modelID})
	if err != nil || len(planner.ActiveModels) != 1 || len(planner.Downloads) != 1 || planner.Downloads[0].Bytes != 16 {
		t.Fatalf("planner accounting was not persisted: %#v %v", planner, err)
	}
	persisted, err := openManagedControllerState(filepath.Join(fixture.base, "controller-state.json"))
	if err != nil || persisted.AppliedGeneration != 1 || persisted.AppliedEnvelopeDigest != plan.EnvelopeDigest {
		t.Fatalf("controller head was not persisted: %#v %v", persisted, err)
	}
	info, err := os.Stat(filepath.Join(fixture.base, "controller-state.json"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("controller state permissions are unsafe: %#v %v", info, err)
	}

	activatedAt := planner.ActiveModels[0].ActivatedAt
	fixture.controller.now = func() time.Time { return fixture.now.Add(10 * time.Second) }
	next := managedControllerTestPlan(2, "b", fixture.now.Add(10*time.Second), []string{modelID}, []plannedModelDownload{}, false)
	if err := fixture.plans.commit(next); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.controller.reconcile(context.Background(), managedControllerFence{PolicyRevision: 1, PlanGeneration: 2, EnvelopeDigest: next.EnvelopeDigest}); err != nil {
		t.Fatal(err)
	}
	planner, err = fixture.plannerState.plannerState([]string{modelID})
	if err != nil || !planner.ActiveModels[0].ActivatedAt.Equal(activatedAt) || len(planner.ModelChanges) != 1 || len(planner.Downloads) != 1 {
		t.Fatalf("new generation reset residency/history: %#v %v", planner, err)
	}
}

func managedControllerCallsContainInOrder(calls, expected []string) bool {
	position := 0
	for _, call := range calls {
		if position < len(expected) && call == expected[position] {
			position++
		}
	}
	return position == len(expected)
}

func TestManagedControllerCancelsSupersededPlanAndFencesStaleCaller(t *testing.T) {
	fixture := newManagedControllerFixture(t)
	modelID := "hf:qwen/qwen2.5-0.5b-instruct"
	fixture.runtime.installed = true
	fixture.runtime.pullStarted = make(chan struct{})
	fixture.runtime.pullRelease = make(chan struct{})
	first := managedControllerTestPlan(1, "a", fixture.now, []string{modelID}, []plannedModelDownload{{ModelID: modelID, Bytes: 16}}, true)
	if err := fixture.plans.commit(first); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := fixture.controller.reconcile(context.Background(), managedControllerFence{PolicyRevision: 1, PlanGeneration: 1, EnvelopeDigest: first.EnvelopeDigest})
		result <- err
	}()
	select {
	case <-fixture.runtime.pullStarted:
	case <-time.After(time.Second):
		t.Fatal("reconcile did not reach pull")
	}
	second := managedControllerTestPlan(2, "b", fixture.now, []string{}, []plannedModelDownload{}, false)
	if err := fixture.plans.commit(second); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if !errors.Is(err, errManagedControllerSuperseded) {
			t.Fatalf("superseded reconcile returned %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("new signed head did not cancel old reconciliation")
	}
	state, err := fixture.plannerState.plannerState([]string{})
	if err != nil || len(state.ActiveModels) != 0 {
		t.Fatalf("superseded plan changed active state: %#v %v", state, err)
	}
	if _, err := fixture.controller.reconcile(context.Background(), managedControllerFence{PolicyRevision: 1, PlanGeneration: 1, EnvelopeDigest: first.EnvelopeDigest}); !errors.Is(err, errManagedControllerFence) {
		t.Fatalf("stale caller was not fenced: %v", err)
	}
}

func TestManagedControllerStopsImmediatelyWhenConsentIsWithdrawn(t *testing.T) {
	fixture := newManagedControllerFixture(t)
	fixture.runtime.installed = true
	fixture.runtime.running = true
	fixture.runtime.stopObserved = make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go fixture.controller.monitorPolicy(ctx)
	current := fixture.policy.snapshot()
	withdrawn := *current
	withdrawn.AllowCloudWorkloads = managedOllamaTestBool(false)
	if _, conflict, err := fixture.policy.replace(current.Revision, withdrawn); err != nil || conflict {
		t.Fatalf("cannot withdraw consent: conflict=%v err=%v", conflict, err)
	}
	select {
	case <-fixture.runtime.stopObserved:
	case <-time.After(time.Second):
		t.Fatal("consent withdrawal did not stop runtime")
	}
	if fixture.runtime.status(nil).Running {
		t.Fatal("runtime remained active after consent withdrawal")
	}
}

func TestManagedControllerStopsAndClearsStateWhenSignedPlanExpires(t *testing.T) {
	fixture := newManagedControllerFixture(t)
	modelID := "hf:qwen/qwen2.5-0.5b-instruct"
	plan := managedControllerTestPlan(1, "a", fixture.now, []string{modelID}, []plannedModelDownload{{ModelID: modelID, Bytes: 16}}, true)
	if err := fixture.plans.commit(plan); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.controller.reconcile(context.Background(), managedControllerFence{
		PolicyRevision: 1, PlanGeneration: 1, EnvelopeDigest: plan.EnvelopeDigest,
	}); err != nil {
		t.Fatal(err)
	}
	fixture.runtime.stopObserved = make(chan struct{})
	timer := make(chan time.Time, 1)
	timerDelay := make(chan time.Duration, 1)
	fixture.controller.expiryAfter = func(delay time.Duration) <-chan time.Time {
		timerDelay <- delay
		return timer
	}
	var clockMu sync.RWMutex
	clock := fixture.now
	fixture.controller.now = func() time.Time {
		clockMu.RLock()
		defer clockMu.RUnlock()
		return clock
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go fixture.controller.monitorPlanExpiry(ctx)
	select {
	case delay := <-timerDelay:
		if delay != time.Minute {
			t.Fatalf("unexpected expiry delay: %v", delay)
		}
	case <-time.After(time.Second):
		t.Fatal("expiry monitor did not install its timer")
	}
	clockMu.Lock()
	clock = fixture.now.Add(time.Minute)
	clockMu.Unlock()
	if view := fixture.controller.status(); view.State != "expired" || !view.Runtime.Running {
		t.Fatalf("expired status was not immediately fail closed: %#v", view)
	}
	timer <- clock
	select {
	case <-fixture.runtime.stopObserved:
	case <-time.After(time.Second):
		t.Fatal("plan expiry did not stop the managed runtime")
	}
	view := fixture.controller.status()
	if view.State != "expired" || view.Runtime.Running || len(view.SelectedModelIDs) != 0 || view.CustomerTrafficAllowed || view.RoutingEligible || view.CompensationEligible {
		t.Fatalf("expired controller view is not fail closed: %#v", view)
	}
	planner, err := fixture.plannerState.plannerState([]string{modelID})
	if err != nil || len(planner.ActiveModels) != 0 || len(planner.Downloads) != 1 || len(planner.ModelChanges) != 2 {
		t.Fatalf("expiry did not preserve accounting while clearing active models: %#v %v", planner, err)
	}
	persisted, err := openManagedControllerState(filepath.Join(fixture.base, "controller-state.json"))
	if err != nil || persisted.AppliedGeneration != 1 || len(persisted.SelectedModelIDs) != 0 {
		t.Fatalf("expiry did not persist the cleared selection: %#v %v", persisted, err)
	}
}

func TestManagedControllerCachesCompletedDownloadAcrossPlanExpiryWithoutActivation(t *testing.T) {
	fixture := newManagedControllerFixture(t)
	modelID := "hf:qwen/qwen2.5-0.5b-instruct"
	fixture.runtime.installed = true
	fixture.runtime.pullStarted = make(chan struct{})
	fixture.runtime.pullRelease = make(chan struct{})
	fixture.runtime.stopObserved = make(chan struct{})

	var clockMu sync.RWMutex
	clock := fixture.now
	fixture.controller.now = func() time.Time {
		clockMu.RLock()
		defer clockMu.RUnlock()
		return clock
	}
	timers := make(chan chan time.Time, 2)
	fixture.controller.expiryAfter = func(time.Duration) <-chan time.Time {
		timer := make(chan time.Time, 1)
		timers <- timer
		return timer
	}
	plan := managedControllerTestPlan(1, "a", fixture.now, []string{modelID}, []plannedModelDownload{{ModelID: modelID, Bytes: 16}}, true)
	if err := fixture.plans.commit(plan); err != nil {
		t.Fatal(err)
	}
	monitorContext, stopMonitor := context.WithCancel(context.Background())
	defer stopMonitor()
	go fixture.controller.monitorPlanExpiry(monitorContext)
	var expiryTimer chan time.Time
	select {
	case expiryTimer = <-timers:
	case <-time.After(time.Second):
		t.Fatal("expiry monitor did not install a timer")
	}
	reconcileResult := make(chan error, 1)
	go func() {
		_, err := fixture.controller.reconcile(context.Background(), managedControllerFence{
			PolicyRevision: 1, PlanGeneration: plan.Generation, EnvelopeDigest: plan.EnvelopeDigest,
		})
		reconcileResult <- err
	}()
	select {
	case <-fixture.runtime.pullStarted:
	case <-time.After(time.Second):
		t.Fatal("reconcile did not start the bounded download")
	}
	clockMu.Lock()
	clock = fixture.now.Add(time.Minute)
	clockMu.Unlock()
	expiryTimer <- clock
	select {
	case err := <-reconcileResult:
		t.Fatalf("expiry cancelled an already-authorized download before it completed: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(fixture.runtime.pullRelease)
	select {
	case err := <-reconcileResult:
		if !errors.Is(err, errManagedControllerPlanExpired) {
			t.Fatalf("expired reconcile returned %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("completed download did not leave the expired reconcile")
	}
	select {
	case <-fixture.runtime.stopObserved:
	case <-time.After(time.Second):
		t.Fatal("expired preparation did not stop its managed runtime")
	}
	view := fixture.controller.status()
	if view.State != "expired" || view.Runtime.Running || len(view.SelectedModelIDs) != 0 || view.CustomerTrafficAllowed || view.RoutingEligible || view.CompensationEligible {
		t.Fatalf("expired preparation crossed activation boundary: %#v", view)
	}
	planner, err := fixture.plannerState.plannerState([]string{modelID})
	if err != nil || len(planner.ActiveModels) != 0 || len(planner.Downloads) != 1 {
		t.Fatalf("verified cache/accounting was not preserved without activation: %#v %v", planner, err)
	}

	clockMu.Lock()
	clock = fixture.now.Add(time.Minute + time.Second)
	clockMu.Unlock()
	fresh := managedControllerTestPlan(2, "b", clock, []string{modelID}, []plannedModelDownload{}, true)
	if err := fixture.plans.commit(fresh); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.controller.reconcile(context.Background(), managedControllerFence{
		PolicyRevision: 1, PlanGeneration: fresh.Generation, EnvelopeDigest: fresh.EnvelopeDigest,
	}); err != nil {
		t.Fatal(err)
	}
	view = fixture.controller.status()
	if view.State != "ready-shadow" || !view.Runtime.Running || !reflect.DeepEqual(view.SelectedModelIDs, []string{modelID}) {
		t.Fatalf("fresh plan did not activate the verified cache: %#v", view)
	}
	fixture.runtime.mu.Lock()
	pulls := 0
	for _, call := range fixture.runtime.calls {
		if call == "pull:"+modelID {
			pulls++
		}
	}
	fixture.runtime.mu.Unlock()
	if pulls != 1 {
		t.Fatalf("fresh plan redownloaded a verified cached model: calls=%v", fixture.runtime.calls)
	}
}

func TestManagedControllerStaleExpiryCannotStopReplacementPlan(t *testing.T) {
	fixture := newManagedControllerFixture(t)
	modelID := "hf:qwen/qwen2.5-0.5b-instruct"
	first := managedControllerTestPlan(1, "a", fixture.now, []string{modelID}, []plannedModelDownload{{ModelID: modelID, Bytes: 16}}, true)
	if err := fixture.plans.commit(first); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.controller.reconcile(context.Background(), managedControllerFence{
		PolicyRevision: 1, PlanGeneration: 1, EnvelopeDigest: first.EnvelopeDigest,
	}); err != nil {
		t.Fatal(err)
	}
	timers := make(chan chan time.Time, 2)
	fixture.controller.expiryAfter = func(time.Duration) <-chan time.Time {
		timer := make(chan time.Time, 1)
		timers <- timer
		return timer
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go fixture.controller.monitorPlanExpiry(ctx)
	var staleTimer chan time.Time
	select {
	case staleTimer = <-timers:
	case <-time.After(time.Second):
		t.Fatal("first expiry timer was not installed")
	}
	second := managedControllerTestPlan(2, "b", fixture.now, []string{modelID}, []plannedModelDownload{}, false)
	second.ExpiresAt = canonicalPlannerTime(fixture.now.Add(2 * time.Minute))
	if err := fixture.plans.commit(second); err != nil {
		t.Fatal(err)
	}
	select {
	case <-timers:
	case <-time.After(time.Second):
		t.Fatal("replacement expiry timer was not installed")
	}
	staleTimer <- fixture.now.Add(time.Minute)
	if err := fixture.controller.expireSignedPlan(first.Generation, first.EnvelopeDigest); err != nil {
		t.Fatal(err)
	}
	fixture.runtime.mu.Lock()
	running := fixture.runtime.running
	stops := 0
	for _, call := range fixture.runtime.calls {
		if call == "stop" {
			stops++
		}
	}
	fixture.runtime.mu.Unlock()
	if !running || stops != 0 {
		t.Fatalf("stale expiry affected replacement head: running=%v stops=%d", running, stops)
	}
	planner, err := fixture.plannerState.plannerState([]string{modelID})
	if err != nil || len(planner.ActiveModels) != 1 {
		t.Fatalf("stale expiry cleared the active set: %#v %v", planner, err)
	}
}

func TestManagedControllerEndpointsAreAuthenticatedBoundedAndFenced(t *testing.T) {
	fixture := newManagedControllerFixture(t)
	modelID := "hf:qwen/qwen2.5-0.5b-instruct"
	plan := managedControllerTestPlan(1, "a", fixture.now, []string{modelID}, []plannedModelDownload{{ModelID: modelID, Bytes: 16}}, true)
	if err := fixture.plans.commit(plan); err != nil {
		t.Fatal(err)
	}
	core, _ := url.Parse("http://127.0.0.1:1455")
	token := strings.Repeat("z", 32)
	handler := providerHandlerWithManagedController(
		core, newMemorySelectionStore([]string{}), newMemoryRuntimeEndpointStore(), nil, nil,
		fixture.policy, nil, fixture.controller, http.DefaultClient, token,
	)
	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/v1/managed-ollama/status", nil))
	if unauthorized.Code != http.StatusNotFound {
		t.Fatalf("unauthorized controller route leaked: %d", unauthorized.Code)
	}

	request := httptest.NewRequest(http.MethodPost, "/v1/managed-ollama/reconcile", bytes.NewReader([]byte(`{"policy_revision":1,"plan_generation":1,"envelope_digest":"`+plan.EnvelopeDigest+`"}`)))
	request.Header.Set("authorization", "Bearer "+token)
	request.Header.Set("content-type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	var view managedControllerView
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &view) != nil || view.State != "ready-shadow" || view.CustomerTrafficAllowed {
		t.Fatalf("reconcile endpoint failed or crossed boundary: %d %s", response.Code, response.Body.String())
	}

	badRequest := httptest.NewRequest(http.MethodPost, "/v1/managed-ollama/start", strings.NewReader(`{"policy_revision":1,"extra":true}`))
	badRequest.Header.Set("authorization", "Bearer "+token)
	badRequest.Header.Set("content-type", "application/json")
	badResponse := httptest.NewRecorder()
	handler.ServeHTTP(badResponse, badRequest)
	if badResponse.Code != http.StatusBadRequest {
		t.Fatalf("unknown control field was accepted: %d", badResponse.Code)
	}

	oversized := httptest.NewRequest(http.MethodPost, "/v1/managed-ollama/start", strings.NewReader(`{"policy_revision":1,"padding":"`+strings.Repeat("x", 5000)+`"}`))
	oversized.Header.Set("authorization", "Bearer "+token)
	oversized.Header.Set("content-type", "application/json")
	oversizedResponse := httptest.NewRecorder()
	handler.ServeHTTP(oversizedResponse, oversized)
	if oversizedResponse.Code != http.StatusBadRequest {
		t.Fatalf("oversized control body was accepted: %d", oversizedResponse.Code)
	}

	stop := httptest.NewRequest(http.MethodPost, "/v1/managed-ollama/stop", strings.NewReader(`{}`))
	stop.Header.Set("authorization", "Bearer "+token)
	stop.Header.Set("content-type", "application/json")
	stopResponse := httptest.NewRecorder()
	handler.ServeHTTP(stopResponse, stop)
	if stopResponse.Code != http.StatusOK {
		t.Fatalf("authenticated stop failed: %d %s", stopResponse.Code, stopResponse.Body.String())
	}
}

func TestProviderHTTPServerBoundsHeadersAndAllowsManagedInstallDeadline(t *testing.T) {
	server := newProviderHTTPServer(http.NotFoundHandler())
	if server.MaxHeaderBytes != 32*1024 || server.ReadHeaderTimeout != 5*time.Second || server.ReadTimeout != 10*time.Second || server.IdleTimeout != 30*time.Second {
		t.Fatalf("provider HTTP server bounds changed unexpectedly: %#v", server)
	}
	if server.WriteTimeout <= managedOllamaDefaultInstallTimeout {
		t.Fatalf("write timeout %v truncates the bounded install deadline %v", server.WriteTimeout, managedOllamaDefaultInstallTimeout)
	}
}
