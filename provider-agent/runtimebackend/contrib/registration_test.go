package contrib

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/thibautrey/multivibe/provider-agent/runtimebackend"
	"github.com/thibautrey/multivibe/provider-agent/runtimebackend/contracttest"
)

type changingDescriptorBackend struct {
	runtimebackend.Backend
	executor    runtimebackend.Executor
	stream      runtimebackend.StreamExecutor
	canceller   runtimebackend.Canceller
	descriptors []runtimebackend.Descriptor
	next        int
	healthState string
}

func (backend *changingDescriptorBackend) Descriptor() runtimebackend.Descriptor {
	index := backend.next
	if index >= len(backend.descriptors) {
		index = len(backend.descriptors) - 1
	}
	backend.next++
	return backend.descriptors[index]
}

func (backend *changingDescriptorBackend) Execute(ctx context.Context, request runtimebackend.ExecutionRequest) (runtimebackend.ExecutionResult, error) {
	return backend.executor.Execute(ctx, request)
}

func (backend *changingDescriptorBackend) ExecuteStream(ctx context.Context, request runtimebackend.ExecutionRequest, emit runtimebackend.EmitFunc) (runtimebackend.ExecutionSummary, error) {
	return backend.stream.ExecuteStream(ctx, request, emit)
}

func (backend *changingDescriptorBackend) Cancel(ctx context.Context, request runtimebackend.CancelRequest) error {
	return backend.canceller.Cancel(ctx, request)
}

func (backend *changingDescriptorBackend) Health(ctx context.Context, grant runtimebackend.OperationGrant) (runtimebackend.Health, error) {
	if backend.healthState != "" {
		return runtimebackend.Health{State: backend.healthState}, nil
	}
	return backend.Backend.Health(ctx, grant)
}

func TestNewStaticRegistryRequiresExplicitPinnedRegistrations(t *testing.T) {
	_, manifest, descriptor := contributionFixture(t)
	backend, err := contracttest.NewFake(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	registry, err := NewStaticRegistry(Registration{Manifest: manifest, Backend: backend})
	if err != nil {
		t.Fatalf("valid static registration rejected: %v", err)
	}
	if ids := registry.IDs(); len(ids) != 1 || ids[0] != descriptor.ID {
		t.Fatalf("unexpected registry IDs: %#v", ids)
	}

	if _, err := NewStaticRegistry(); !errors.Is(err, ErrInvalidManifest) {
		t.Fatalf("empty registration list accepted: %v", err)
	}
	if _, err := NewStaticRegistry(
		Registration{Manifest: manifest, Backend: backend},
		Registration{Manifest: manifest, Backend: backend},
	); !errors.Is(err, ErrInvalidManifest) {
		t.Fatalf("duplicate static registration accepted: %v", err)
	}
}

func TestVerifyRegistrationRejectsDescriptorDriftAndTypedNil(t *testing.T) {
	_, manifest, descriptor := contributionFixture(t)
	backend, err := contracttest.NewFake(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	candidate := manifest
	candidate.DescriptorSHA256 = "sha256:" + strings.Repeat("f", 64)
	if err := VerifyRegistration(Registration{Manifest: candidate, Backend: backend}); !errors.Is(err, ErrDescriptorMismatch) {
		t.Fatalf("descriptor drift was accepted: %v", err)
	}

	candidate = manifest
	candidate.BackendID = "different-backend"
	if err := VerifyRegistration(Registration{Manifest: candidate, Backend: backend}); !errors.Is(err, ErrDescriptorMismatch) {
		t.Fatalf("backend ID mismatch was accepted: %v", err)
	}

	var typedNil *contracttest.Fake
	if err := VerifyRegistration(Registration{Manifest: manifest, Backend: typedNil}); !errors.Is(err, ErrDescriptorMismatch) {
		t.Fatalf("typed nil backend was accepted: %v", err)
	}
}

func TestRegistrationDoesNotExposeDynamicLoadingSurface(t *testing.T) {
	typeOfRegistration := reflect.TypeOf(Registration{})
	if typeOfRegistration.NumField() != 2 || typeOfRegistration.Field(0).Name != "Manifest" || typeOfRegistration.Field(1).Name != "Backend" {
		t.Fatalf("registration gained an unreviewed loading surface: %v", typeOfRegistration)
	}
	// Compile-time assignment documents the only accepted code-bearing value:
	// an already constructed Go interface. No path, symbol, argv or hook exists.
	var _ runtimebackend.Backend = (*contracttest.Fake)(nil)
}

func TestStaticRegistrationEnforcesShadowOnlyTrafficPolicy(t *testing.T) {
	_, manifest, descriptor := contributionFixture(t)
	for name, capabilities := range map[string]runtimebackend.Capabilities{
		"shadow disabled":  {Execute: true, Stream: true, Cancel: true, ShadowOnly: false, CustomerTraffic: false},
		"customer traffic": {Execute: true, Stream: true, Cancel: true, ShadowOnly: false, CustomerTraffic: true},
	} {
		t.Run(name, func(t *testing.T) {
			candidateDescriptor := descriptor
			candidateDescriptor.Capabilities = capabilities
			backend, err := contracttest.NewFake(candidateDescriptor)
			if err != nil {
				t.Fatal(err)
			}
			candidateManifest := manifest
			candidateManifest.DescriptorSHA256, err = DescriptorDigest(candidateDescriptor)
			if err != nil {
				t.Fatal(err)
			}
			registration := Registration{Manifest: candidateManifest, Backend: backend}
			if err := VerifyRegistration(registration); !errors.Is(err, ErrUnsafeTrafficPolicy) {
				t.Fatalf("unsafe traffic policy was accepted: %v", err)
			}
			if _, err := NewStaticRegistry(registration); !errors.Is(err, ErrUnsafeTrafficPolicy) {
				t.Fatalf("unsafe traffic policy entered registry: %v", err)
			}
		})
	}
}

func TestStaticRegistrationPinsOneDescriptorSnapshotPerInstance(t *testing.T) {
	_, manifest, safeDescriptor := contributionFixture(t)
	implementation, err := contracttest.NewFake(safeDescriptor)
	if err != nil {
		t.Fatal(err)
	}
	unsafeDescriptor := safeDescriptor
	unsafeDescriptor.Capabilities.Execute = true
	unsafeDescriptor.Capabilities.ShadowOnly = false
	unsafeDescriptor.Capabilities.CustomerTraffic = true
	changing := &changingDescriptorBackend{
		Backend: implementation, executor: implementation, stream: implementation, canceller: implementation,
		descriptors: []runtimebackend.Descriptor{safeDescriptor, unsafeDescriptor}, healthState: "single-instance",
	}
	if err := runtimebackend.ValidateDescriptor(unsafeDescriptor); err != nil {
		t.Fatalf("unsafe traffic descriptor must remain structurally valid for the TOCTOU test: %v", err)
	}
	if _, ok := any(changing).(runtimebackend.Executor); !ok {
		t.Fatal("TOCTOU test backend lost its optional execution surface")
	}
	registry, err := NewStaticRegistry(Registration{Manifest: manifest, Backend: changing})
	if err != nil {
		t.Fatalf("single safe descriptor snapshot was not pinned: %v", err)
	}
	stored, found := registry.Descriptor(safeDescriptor.ID)
	storedDigest, digestErr := DescriptorDigest(stored)
	if !found || digestErr != nil || storedDigest != manifest.DescriptorSHA256 || changing.next != 1 {
		t.Fatalf("registry did not retain the single reviewed snapshot: %#v calls=%d", stored, changing.next)
	}
	registered, found := registry.Backend(safeDescriptor.ID)
	if !found {
		t.Fatal("reviewed backend was not registered")
	}
	health, healthErr := registered.Health(context.Background(), registrationGrant(safeDescriptor))
	if healthErr != nil || health.State != changing.healthState {
		t.Fatal("reviewed descriptor was not bound to its concrete instance")
	}
}

func TestStaticRegistrationCannotSwapInstancesBetweenManifests(t *testing.T) {
	_, firstManifest, firstDescriptor := contributionFixture(t)
	secondDescriptor := cloneRegisteredDescriptor(firstDescriptor)
	secondDescriptor.ID = "example-static-b"
	secondDescriptor.Priority++
	secondManifest := firstManifest
	secondManifest.BackendID = secondDescriptor.ID
	var err error
	secondManifest.DescriptorSHA256, err = DescriptorDigest(secondDescriptor)
	if err != nil {
		t.Fatal(err)
	}
	firstImplementation, err := contracttest.NewFake(firstDescriptor)
	if err != nil {
		t.Fatal(err)
	}
	secondImplementation, err := contracttest.NewFake(secondDescriptor)
	if err != nil {
		t.Fatal(err)
	}
	first := &changingDescriptorBackend{
		Backend: firstImplementation, executor: firstImplementation, stream: firstImplementation, canceller: firstImplementation,
		descriptors: []runtimebackend.Descriptor{firstDescriptor, secondDescriptor}, healthState: "first-instance",
	}
	second := &changingDescriptorBackend{
		Backend: secondImplementation, executor: secondImplementation, stream: secondImplementation, canceller: secondImplementation,
		descriptors: []runtimebackend.Descriptor{secondDescriptor, firstDescriptor}, healthState: "second-instance",
	}
	registry, err := NewStaticRegistry(
		Registration{Manifest: firstManifest, Backend: first},
		Registration{Manifest: secondManifest, Backend: second},
	)
	if err != nil {
		t.Fatalf("single-snapshot registrations were rejected: %v", err)
	}
	for id, want := range map[string]string{firstDescriptor.ID: first.healthState, secondDescriptor.ID: second.healthState} {
		registered, found := registry.Backend(id)
		if !found {
			t.Fatalf("manifest %q was not registered", id)
		}
		descriptor, _ := registry.Descriptor(id)
		health, healthErr := registered.Health(context.Background(), registrationGrant(descriptor))
		if healthErr != nil || health.State != want {
			t.Fatalf("manifest %q was rebound to another instance", id)
		}
	}
	if first.next != 1 || second.next != 1 {
		t.Fatalf("backend descriptors were read more than once: first=%d second=%d", first.next, second.next)
	}
}

func registrationGrant(descriptor runtimebackend.Descriptor) runtimebackend.OperationGrant {
	now := time.Now()
	return runtimebackend.OperationGrant{
		ID: "static-registration-grant", PolicyRevision: 1, TrafficClass: runtimebackend.TrafficClassShadow,
		IssuedAt: now.Add(-time.Minute), ExpiresAt: now.Add(time.Hour), AllowedModelIDs: []string{"fixture/model"},
		Limits: descriptor.Limits,
	}
}
