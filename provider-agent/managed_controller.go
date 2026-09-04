package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	managedControllerStateSchemaVersion = "provider-managed-controller-state-v1"
	managedControllerViewSchemaVersion  = "provider-managed-controller-view-v1"
	managedControllerStateMaximumBytes  = 256 * 1024
)

var (
	errManagedControllerFence       = errors.New("managed controller revision fence rejected the operation")
	errManagedControllerNoPlan      = errors.New("managed controller has no signed plan")
	errManagedControllerPlanExpired = errors.New("managed controller signed plan expired")
	errManagedControllerConsent     = errors.New("managed controller is not authorized by local consent")
	errManagedControllerSuperseded  = errors.New("managed controller operation was superseded")
)

type managedControllerRuntime interface {
	ensureRuntime(context.Context, *capacityPolicyStateDocument, string) (managedOllamaStatus, error)
	start(context.Context, *capacityPolicyStateDocument) (managedOllamaStatus, error)
	stop(context.Context) error
	enforcePolicy(context.Context, *capacityPolicyStateDocument) error
	status(*capacityPolicyStateDocument) managedOllamaStatus
	pullModelResult(context.Context, *capacityPolicyStateDocument, string, plannedModelDownload) (managedOllamaModelRecord, bool, error)
	authorizeModelActivation(*capacityPolicyStateDocument, string, string) (managedOllamaModelRecord, error)
	deactivateModel(context.Context, *capacityPolicyStateDocument, string, string) error
	managedInventory(*capacityPolicyStateDocument) ([]string, error)
}

type managedControllerState struct {
	SchemaVersion         string   `json:"schema_version"`
	AppliedGeneration     uint64   `json:"applied_generation"`
	AppliedEnvelopeDigest string   `json:"applied_envelope_digest,omitempty"`
	AppliedPolicyRevision uint64   `json:"applied_policy_revision"`
	SelectedModelIDs      []string `json:"selected_model_ids"`
	UpdatedAt             string   `json:"updated_at,omitempty"`
}

type managedControllerView struct {
	SchemaVersion          string              `json:"schema_version"`
	State                  string              `json:"state"`
	Operation              string              `json:"operation,omitempty"`
	HeadGeneration         uint64              `json:"head_generation"`
	HeadEnvelopeDigest     string              `json:"head_envelope_digest,omitempty"`
	AppliedGeneration      uint64              `json:"applied_generation"`
	AppliedEnvelopeDigest  string              `json:"applied_envelope_digest,omitempty"`
	AppliedPolicyRevision  uint64              `json:"applied_policy_revision"`
	PolicyRevision         uint64              `json:"policy_revision"`
	SelectedModelIDs       []string            `json:"selected_model_ids"`
	ShadowOnly             bool                `json:"shadow_only"`
	CustomerTrafficAllowed bool                `json:"customer_traffic_allowed"`
	RoutingEligible        bool                `json:"routing_eligible"`
	CompensationEligible   bool                `json:"compensation_eligible"`
	Runtime                managedOllamaStatus `json:"runtime"`
}

type managedControllerFence struct {
	PolicyRevision uint64 `json:"policy_revision"`
	PlanGeneration uint64 `json:"plan_generation,omitempty"`
	EnvelopeDigest string `json:"envelope_digest,omitempty"`
}

type managedProviderController struct {
	mu                     sync.Mutex
	operationMu            sync.Mutex
	runtime                managedControllerRuntime
	policy                 *capacityPolicyStore
	plans                  *providerDemandPlanStore
	plannerState           *managedPlannerStateStore
	catalogPath            string
	dependencyManifestPath string
	statePath              string
	state                  managedControllerState
	operation              string
	operationGeneration    uint64
	operationDigest        string
	currentCancel          context.CancelFunc
	now                    func() time.Time
	expiryAfter            func(time.Duration) <-chan time.Time
}

func emptyManagedControllerState() managedControllerState {
	return managedControllerState{SchemaVersion: managedControllerStateSchemaVersion, SelectedModelIDs: []string{}}
}

func newManagedProviderController(
	runtime managedControllerRuntime,
	policy *capacityPolicyStore,
	plans *providerDemandPlanStore,
	plannerState *managedPlannerStateStore,
	catalogPath string,
	dependencyManifestPath string,
	statePath string,
) (*managedProviderController, error) {
	if runtime == nil || policy == nil || plans == nil || plannerState == nil {
		return nil, errors.New("managed controller dependencies are incomplete")
	}
	for _, path := range []string{catalogPath, dependencyManifestPath, statePath} {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path {
			return nil, errors.New("managed controller paths must be clean and absolute")
		}
	}
	if _, err := openProviderModelCatalog(catalogPath); err != nil {
		return nil, errors.New("managed controller model catalog is invalid")
	}
	if _, err := openManagedOllamaDependencyManifest(dependencyManifestPath); err != nil {
		return nil, errors.New("managed controller dependency manifest is invalid")
	}
	state, err := openManagedControllerState(statePath)
	if err != nil {
		return nil, err
	}
	return &managedProviderController{
		runtime: runtime, policy: policy, plans: plans, plannerState: plannerState,
		catalogPath: catalogPath, dependencyManifestPath: dependencyManifestPath,
		statePath: statePath, state: state, now: time.Now, expiryAfter: time.After,
	}, nil
}

func openManagedControllerState(path string) (managedControllerState, error) {
	empty := emptyManagedControllerState()
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return empty, nil
	}
	if err != nil || !providerPrivateFile(path, info) ||
		info.Size() < 1 || info.Size() > managedControllerStateMaximumBytes {
		return managedControllerState{}, errors.New("managed controller state must be a bounded mode-0600 regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return managedControllerState{}, errors.New("managed controller state cannot be opened")
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, managedControllerStateMaximumBytes+1))
	if err != nil || len(raw) > managedControllerStateMaximumBytes || validateUniqueJSONKeys(raw) != nil {
		return managedControllerState{}, errors.New("managed controller state is invalid")
	}
	var state managedControllerState
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&state) != nil || ensureJSONEOF(decoder) != nil || validateManagedControllerState(state) != nil {
		return managedControllerState{}, errors.New("managed controller state is invalid")
	}
	return state, nil
}

func validateManagedControllerState(state managedControllerState) error {
	if state.SchemaVersion != managedControllerStateSchemaVersion || state.SelectedModelIDs == nil || len(state.SelectedModelIDs) > maximumPlannerItems {
		return errors.New("managed controller state is invalid")
	}
	if state.AppliedGeneration == 0 {
		if state.AppliedEnvelopeDigest != "" || state.AppliedPolicyRevision != 0 || state.UpdatedAt != "" || len(state.SelectedModelIDs) != 0 {
			return errors.New("managed controller state is invalid")
		}
		return nil
	}
	if !providerDigest.MatchString(state.AppliedEnvelopeDigest) || state.AppliedPolicyRevision < 1 {
		return errors.New("managed controller state is invalid")
	}
	if _, err := canonicalTimestamp(state.UpdatedAt); err != nil {
		return errors.New("managed controller state is invalid")
	}
	previous := ""
	for _, modelID := range state.SelectedModelIDs {
		if !validSelectedModelID(modelID) || modelID <= previous {
			return errors.New("managed controller state is invalid")
		}
		previous = modelID
	}
	return nil
}

func (controller *managedProviderController) persistApplied(target *providerDemandPlanState, policy *capacityPolicyStateDocument, now time.Time) error {
	state := managedControllerState{
		SchemaVersion: managedControllerStateSchemaVersion, AppliedGeneration: target.Generation,
		AppliedEnvelopeDigest: target.EnvelopeDigest, AppliedPolicyRevision: policy.Revision,
		SelectedModelIDs: append([]string{}, target.Plan.SelectedModelIDs...), UpdatedAt: canonicalPlannerTime(now),
	}
	if validateManagedControllerState(state) != nil {
		return errors.New("managed controller applied state is invalid")
	}
	encoded, err := json.Marshal(state)
	if err != nil || len(encoded) > managedControllerStateMaximumBytes {
		return errors.New("managed controller applied state cannot be encoded")
	}
	if err := atomicWrite0600(controller.statePath, append(encoded, '\n')); err != nil {
		return errors.New("managed controller applied state cannot be persisted")
	}
	controller.mu.Lock()
	controller.state = state
	controller.mu.Unlock()
	return nil
}

func (controller *managedProviderController) clearAppliedSelection(now time.Time) error {
	controller.mu.Lock()
	state := controller.state
	controller.mu.Unlock()
	if len(state.SelectedModelIDs) == 0 {
		return nil
	}
	if state.AppliedGeneration == 0 || now.IsZero() {
		return errors.New("managed controller applied selection cannot be cleared")
	}
	state.SelectedModelIDs = []string{}
	state.UpdatedAt = canonicalPlannerTime(now)
	if validateManagedControllerState(state) != nil {
		return errors.New("managed controller applied selection is invalid")
	}
	encoded, err := json.Marshal(state)
	if err != nil || len(encoded) > managedControllerStateMaximumBytes {
		return errors.New("managed controller applied selection cannot be encoded")
	}
	if err := atomicWrite0600(controller.statePath, append(encoded, '\n')); err != nil {
		return errors.New("managed controller applied selection cannot be persisted")
	}
	controller.mu.Lock()
	controller.state = state
	controller.mu.Unlock()
	return nil
}

func (controller *managedProviderController) status() managedControllerView {
	policy := controller.policy.snapshot()
	head := controller.plans.snapshot()
	headExpired := false
	if head != nil {
		expiresAt, err := canonicalTimestamp(head.ExpiresAt)
		headExpired = err != nil || !controller.now().UTC().Before(expiresAt)
	}
	controller.mu.Lock()
	state := controller.state
	operation := controller.operation
	controller.mu.Unlock()
	view := managedControllerView{
		SchemaVersion:     managedControllerViewSchemaVersion,
		AppliedGeneration: state.AppliedGeneration, AppliedEnvelopeDigest: state.AppliedEnvelopeDigest,
		AppliedPolicyRevision: state.AppliedPolicyRevision, SelectedModelIDs: append([]string{}, state.SelectedModelIDs...),
		ShadowOnly: true, CustomerTrafficAllowed: false, RoutingEligible: false, CompensationEligible: false,
		Runtime: controller.runtime.status(policy), Operation: operation,
	}
	if policy != nil {
		view.PolicyRevision = policy.Revision
	}
	if head != nil {
		view.HeadGeneration = head.Generation
		view.HeadEnvelopeDigest = head.EnvelopeDigest
	}
	switch {
	case !managedControllerPolicyConsented(policy):
		view.State = "blocked"
	case headExpired:
		view.State = "expired"
	case operation != "":
		view.State = "reconciling"
	case view.Runtime.Running && state.AppliedGeneration != 0 && head != nil && state.AppliedGeneration == head.Generation && state.AppliedEnvelopeDigest == head.EnvelopeDigest:
		view.State = "ready-shadow"
	default:
		view.State = "stopped"
	}
	return view
}

func managedControllerPolicyConsented(policy *capacityPolicyStateDocument) bool {
	return policy != nil && validateCapacityPolicyState(*policy) == nil && !*policy.Paused && *policy.AllowCloudWorkloads
}

func (controller *managedProviderController) fencedPolicy(expectedRevision uint64) (*capacityPolicyStateDocument, <-chan struct{}, error) {
	policy, changed := controller.policy.snapshotWithChange()
	if !managedControllerPolicyConsented(policy) {
		return nil, changed, errManagedControllerConsent
	}
	if expectedRevision < 1 || policy.Revision != expectedRevision {
		return nil, changed, errManagedControllerFence
	}
	return policy, changed, nil
}

func (controller *managedProviderController) fencedPlan(expectedGeneration uint64, expectedDigest string, now time.Time) (*providerDemandPlanState, <-chan struct{}, error) {
	target, changed := controller.plans.snapshotWithChange()
	if target == nil {
		return nil, changed, errManagedControllerNoPlan
	}
	if expectedGeneration < 1 || target.Generation != expectedGeneration || target.EnvelopeDigest != expectedDigest {
		return nil, changed, errManagedControllerFence
	}
	expiresAt, err := canonicalTimestamp(target.ExpiresAt)
	if err != nil || !now.Before(expiresAt) {
		return nil, changed, errManagedControllerPlanExpired
	}
	return target, changed, nil
}

func managedControllerChangeContext(parent context.Context, policyChanged, planChanged <-chan struct{}, deadline time.Time) (context.Context, context.CancelFunc) {
	var contextWithCancel context.Context
	var cancel context.CancelFunc
	if deadline.IsZero() {
		contextWithCancel, cancel = context.WithCancel(parent)
	} else {
		contextWithCancel, cancel = context.WithDeadline(parent, deadline)
	}
	go func() {
		select {
		case <-policyChanged:
			cancel()
		case <-planChanged:
			cancel()
		case <-contextWithCancel.Done():
		}
	}()
	return contextWithCancel, cancel
}

func (controller *managedProviderController) beginOperation(name string, cancel context.CancelFunc, generation uint64, envelopeDigest string) {
	controller.mu.Lock()
	controller.operation = name
	controller.operationGeneration = generation
	controller.operationDigest = envelopeDigest
	controller.currentCancel = cancel
	controller.mu.Unlock()
}

func (controller *managedProviderController) endOperation(cancel context.CancelFunc) {
	cancel()
	controller.mu.Lock()
	controller.operation = ""
	controller.operationGeneration = 0
	controller.operationDigest = ""
	controller.currentCancel = nil
	controller.mu.Unlock()
}

func (controller *managedProviderController) cancelCurrent() {
	controller.mu.Lock()
	cancel := controller.currentCancel
	controller.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (controller *managedProviderController) cancelCurrentPlan(generation uint64, envelopeDigest string) {
	controller.mu.Lock()
	cancel := controller.currentCancel
	if controller.operationGeneration != generation || controller.operationDigest != envelopeDigest {
		cancel = nil
	}
	controller.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (controller *managedProviderController) install(ctx context.Context, expectedPolicyRevision uint64) (managedControllerView, error) {
	controller.operationMu.Lock()
	defer controller.operationMu.Unlock()
	policy, policyChanged, err := controller.fencedPolicy(expectedPolicyRevision)
	if err != nil {
		return controller.status(), err
	}
	operationContext, cancel := managedControllerChangeContext(ctx, policyChanged, nil, time.Time{})
	controller.beginOperation("install", cancel, 0, "")
	defer controller.endOperation(cancel)
	if _, err := controller.runtime.ensureRuntime(operationContext, policy, controller.dependencyManifestPath); err != nil {
		return controller.status(), controller.operationError(operationContext, err)
	}
	if err := controller.checkPolicyFence(policy); err != nil {
		return controller.status(), err
	}
	controller.endOperation(cancel)
	return controller.status(), nil
}

func (controller *managedProviderController) start(ctx context.Context, expectedPolicyRevision uint64) (managedControllerView, error) {
	controller.operationMu.Lock()
	defer controller.operationMu.Unlock()
	policy, policyChanged, err := controller.fencedPolicy(expectedPolicyRevision)
	if err != nil {
		return controller.status(), err
	}
	operationContext, cancel := managedControllerChangeContext(ctx, policyChanged, nil, time.Time{})
	controller.beginOperation("start", cancel, 0, "")
	defer controller.endOperation(cancel)
	if _, err := controller.runtime.start(operationContext, policy); err != nil {
		return controller.status(), controller.operationError(operationContext, err)
	}
	if err := controller.checkPolicyFence(policy); err != nil {
		return controller.status(), err
	}
	controller.endOperation(cancel)
	return controller.status(), nil
}

func (controller *managedProviderController) stop(ctx context.Context) (managedControllerView, error) {
	controller.cancelCurrent()
	if err := controller.runtime.stop(ctx); err != nil {
		return controller.status(), err
	}
	return controller.status(), nil
}

func (controller *managedProviderController) reconcile(ctx context.Context, fence managedControllerFence) (managedControllerView, error) {
	controller.operationMu.Lock()
	defer controller.operationMu.Unlock()
	now := controller.now().UTC()
	policy, policyChanged, err := controller.fencedPolicy(fence.PolicyRevision)
	if err != nil {
		return controller.status(), err
	}
	target, planChanged, err := controller.fencedPlan(fence.PlanGeneration, fence.EnvelopeDigest, now)
	if err != nil {
		return controller.status(), err
	}
	// A plan must be fresh when preparation starts and again before every
	// activation/apply step. An already-authorized, catalog-pinned download may
	// finish after the short demand lease so its verified blobs can remain in the
	// local cache. Policy withdrawal or plan replacement still cancels it, and no
	// expired plan can activate a model or become ready-shadow.
	operationContext, cancel := managedControllerChangeContext(ctx, policyChanged, planChanged, time.Time{})
	controller.beginOperation("reconcile", cancel, target.Generation, target.EnvelopeDigest)
	defer controller.endOperation(cancel)

	inventory, err := controller.runtime.managedInventory(policy)
	if err != nil {
		return controller.status(), controller.operationError(operationContext, err)
	}
	plannerBefore, err := controller.plannerState.plannerState(inventory)
	if err != nil {
		return controller.status(), err
	}
	if err := controller.checkFences(policy, target); err != nil {
		return controller.status(), err
	}

	if len(target.Plan.SelectedModelIDs) > 0 {
		runtimeStatus := controller.runtime.status(policy)
		if !runtimeStatus.RuntimeInstalled {
			if _, err := controller.runtime.ensureRuntime(operationContext, policy, controller.dependencyManifestPath); err != nil {
				return controller.status(), controller.operationError(operationContext, err)
			}
		}
		if _, err := controller.runtime.start(operationContext, policy); err != nil {
			return controller.status(), controller.operationError(operationContext, err)
		}
	}

	for _, download := range target.Plan.Downloads {
		if err := controller.checkFences(policy, target); err != nil {
			return controller.status(), err
		}
		_, downloaded, err := controller.runtime.pullModelResult(operationContext, policy, controller.catalogPath, download)
		if err != nil {
			return controller.status(), controller.operationError(operationContext, err)
		}
		if downloaded {
			if err := controller.plannerState.recordDownloads([]plannedModelDownload{download}, controller.now().UTC()); err != nil {
				return controller.status(), err
			}
		}
	}

	for _, modelID := range target.Plan.SelectedModelIDs {
		if err := controller.checkFences(policy, target); err != nil {
			return controller.status(), err
		}
		if _, err := controller.runtime.authorizeModelActivation(policy, controller.catalogPath, modelID); err != nil {
			return controller.status(), err
		}
	}

	selected := make(map[string]struct{}, len(target.Plan.SelectedModelIDs))
	for _, modelID := range target.Plan.SelectedModelIDs {
		selected[modelID] = struct{}{}
	}
	if controller.runtime.status(policy).Running {
		for _, active := range plannerBefore.ActiveModels {
			if _, remainsSelected := selected[active.ModelID]; remainsSelected {
				continue
			}
			if err := controller.checkFences(policy, target); err != nil {
				return controller.status(), err
			}
			if err := controller.runtime.deactivateModel(operationContext, policy, controller.catalogPath, active.ModelID); err != nil {
				return controller.status(), controller.operationError(operationContext, err)
			}
		}
	}
	if len(target.Plan.SelectedModelIDs) == 0 {
		if err := controller.runtime.stop(operationContext); err != nil {
			return controller.status(), controller.operationError(operationContext, err)
		}
	}
	if err := controller.checkFences(policy, target); err != nil {
		return controller.status(), err
	}
	currentIDs := make([]string, 0, len(plannerBefore.ActiveModels))
	for _, active := range plannerBefore.ActiveModels {
		currentIDs = append(currentIDs, active.ModelID)
	}
	if !equalStrings(currentIDs, target.Plan.SelectedModelIDs) {
		if err := controller.plannerState.recordAppliedPlanAfterRecordedDownloads(target.Plan, controller.now().UTC()); err != nil {
			return controller.status(), err
		}
	}
	if err := controller.checkFences(policy, target); err != nil {
		return controller.status(), err
	}
	if err := controller.persistApplied(target, policy, controller.now().UTC()); err != nil {
		return controller.status(), err
	}
	controller.endOperation(cancel)
	return controller.status(), nil
}

func (controller *managedProviderController) operationError(ctx context.Context, actionErr error) error {
	if ctx.Err() != nil {
		return errManagedControllerSuperseded
	}
	return actionErr
}

func (controller *managedProviderController) checkPolicyFence(expected *capacityPolicyStateDocument) error {
	current := controller.policy.snapshot()
	if current == nil || current.Revision != expected.Revision || !managedControllerPolicyConsented(current) {
		return errManagedControllerSuperseded
	}
	return nil
}

func (controller *managedProviderController) checkFences(policy *capacityPolicyStateDocument, target *providerDemandPlanState) error {
	if err := controller.checkPolicyFence(policy); err != nil {
		return err
	}
	current := controller.plans.snapshot()
	if current == nil || current.Generation != target.Generation || current.EnvelopeDigest != target.EnvelopeDigest {
		return errManagedControllerSuperseded
	}
	expiresAt, err := canonicalTimestamp(current.ExpiresAt)
	if err != nil || !controller.now().UTC().Before(expiresAt) {
		return errManagedControllerPlanExpired
	}
	return nil
}

func (controller *managedProviderController) plannerSnapshot() (modelPlannerState, error) {
	policy := controller.policy.snapshot()
	if !managedControllerPolicyConsented(policy) {
		return modelPlannerState{}, errManagedControllerConsent
	}
	inventory, err := controller.runtime.managedInventory(policy)
	if err != nil {
		return modelPlannerState{}, err
	}
	return controller.plannerState.plannerState(inventory)
}

func (controller *managedProviderController) enforceCurrentPolicy(ctx context.Context) error {
	policy := controller.policy.snapshot()
	if !managedControllerPolicyConsented(policy) {
		controller.cancelCurrent()
		return controller.runtime.stop(ctx)
	}
	if err := controller.runtime.enforcePolicy(ctx, policy); err != nil {
		controller.cancelCurrent()
		_ = controller.runtime.stop(ctx)
		return err
	}
	return nil
}

func (controller *managedProviderController) monitorPolicy(ctx context.Context) {
	_ = controller.enforceCurrentPolicy(ctx)
	for {
		_, changed := controller.policy.snapshotWithChange()
		select {
		case <-ctx.Done():
			controller.cancelCurrent()
			_ = controller.runtime.stop(context.Background())
			return
		case <-changed:
			_ = controller.enforceCurrentPolicy(ctx)
		}
	}
}

func (controller *managedProviderController) expireSignedPlan(generation uint64, envelopeDigest string) error {
	// Do not cancel an already-authorized preparation solely because its short
	// demand lease elapsed. Status becomes expired immediately; this lock then
	// waits for the bounded preparation to finish, after which reconcile's fence
	// rejects activation and the runtime is stopped. Policy changes and plan
	// replacements retain their independent immediate cancellation paths.
	expired := false
	_, clearErr := controller.plans.withCurrent(generation, envelopeDigest, func(current *providerDemandPlanState) error {
		expiresAt, parseErr := canonicalTimestamp(current.ExpiresAt)
		now := controller.now().UTC()
		if parseErr == nil && now.Before(expiresAt) {
			return nil
		}
		expired = true
		// Clear both authoritative active-set views immediately. A bounded
		// preparation may still be completing under operationMu, but it cannot be
		// represented as active or ready-shadow after the lease boundary.
		plannerErr := controller.plannerState.clearActiveModels(now)
		stateErr := controller.clearAppliedSelection(now)
		return errors.Join(parseErr, plannerErr, stateErr)
	})
	if !expired {
		return clearErr
	}
	controller.operationMu.Lock()
	defer controller.operationMu.Unlock()
	_, stopErr := controller.plans.withCurrent(generation, envelopeDigest, func(current *providerDemandPlanState) error {
		expiresAt, parseErr := canonicalTimestamp(current.ExpiresAt)
		if parseErr == nil && controller.now().UTC().Before(expiresAt) {
			return nil
		}
		return errors.Join(parseErr, controller.runtime.stop(context.Background()))
	})
	return errors.Join(clearErr, stopErr)
}

// monitorPlanExpiry enforces the lifetime of the persisted signed head without
// relying on a control request. Each replacement closes changed and installs a
// new timer; expireSignedPlan re-fences under the plan-store lock before any
// stop, so a timer for an older generation cannot affect the new one.
func (controller *managedProviderController) monitorPlanExpiry(ctx context.Context) {
	for {
		head, changed := controller.plans.snapshotWithChange()
		if head == nil {
			select {
			case <-ctx.Done():
				return
			case <-changed:
				continue
			}
		}
		expiresAt, err := canonicalTimestamp(head.ExpiresAt)
		if err != nil {
			_ = controller.expireSignedPlan(head.Generation, head.EnvelopeDigest)
		} else {
			remaining := expiresAt.Sub(controller.now().UTC())
			if remaining > 0 {
				after := controller.expiryAfter
				if after == nil {
					after = time.After
				}
				select {
				case <-ctx.Done():
					return
				case <-changed:
					continue
				case <-after(remaining):
				}
			}
			_ = controller.expireSignedPlan(head.Generation, head.EnvelopeDigest)
		}
		// An expired head stays expired. Wait for replacement instead of spinning
		// and repeatedly signalling an already stopped runtime.
		select {
		case <-ctx.Done():
			return
		case <-changed:
		}
	}
}

func decodeManagedControllerFence(body io.Reader, needsPlan bool) (managedControllerFence, error) {
	var fence managedControllerFence
	decoder := json.NewDecoder(io.LimitReader(body, 4097))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&fence) != nil || ensureJSONEOF(decoder) != nil {
		return managedControllerFence{}, errManagedControllerFence
	}
	if fence.PolicyRevision < 1 || (needsPlan && (fence.PlanGeneration < 1 || !providerDigest.MatchString(fence.EnvelopeDigest))) ||
		(!needsPlan && (fence.PlanGeneration != 0 || fence.EnvelopeDigest != "")) {
		return managedControllerFence{}, errManagedControllerFence
	}
	return fence, nil
}
