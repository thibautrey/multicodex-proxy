package contrib

import (
	"context"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"reflect"

	"github.com/thibautrey/multivibe/provider-agent/runtimebackend"
)

// Registration couples one reviewed data manifest to one concrete Go backend
// value. Registrations must be listed by the worker at compile time; there is
// no init hook, global registry, directory scan or name-to-code resolver.
type Registration struct {
	Manifest Manifest
	Backend  runtimebackend.Backend
}

// VerifyRegistration binds a contribution manifest to its public descriptor.
func VerifyRegistration(registration Registration) error {
	if nilBackend(registration.Backend) {
		return ErrDescriptorMismatch
	}
	if err := registration.Manifest.Validate(); err != nil {
		return err
	}
	descriptor := cloneRegisteredDescriptor(registration.Backend.Descriptor())
	if err := verifyRegisteredDescriptor(registration.Manifest, descriptor); err != nil {
		return err
	}
	return verifyAdvertisedInterfaces(registration.Backend, descriptor.Capabilities)
}

func verifyRegisteredDescriptor(manifest Manifest, descriptor runtimebackend.Descriptor) error {
	if err := runtimebackend.ValidateDescriptor(descriptor); err != nil ||
		descriptor.ID != manifest.BackendID ||
		descriptor.ContractVersion != manifest.BackendContractVersion {
		return ErrDescriptorMismatch
	}
	if !descriptor.Capabilities.ShadowOnly || descriptor.Capabilities.CustomerTraffic {
		return ErrUnsafeTrafficPolicy
	}
	digest, err := DescriptorDigest(descriptor)
	if err != nil {
		return err
	}
	expectedBytes, expectedErr := hex.DecodeString(manifest.DescriptorSHA256[len("sha256:"):])
	actualBytes, actualErr := hex.DecodeString(digest[len("sha256:"):])
	if expectedErr != nil || actualErr != nil || subtle.ConstantTimeCompare(expectedBytes, actualBytes) != 1 {
		return ErrDescriptorMismatch
	}
	return nil
}

func nilBackend(backend runtimebackend.Backend) bool {
	if backend == nil {
		return true
	}
	value := reflect.ValueOf(backend)
	switch value.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return value.IsNil()
	default:
		return false
	}
}

// pinnedDescriptorBackend is the exact instance/descriptor pair attested by
// NewStaticRegistry. Embedding forwards mandatory lifecycle methods while the
// explicit optional methods keep undeclared execution surfaces fail closed.
type pinnedDescriptorBackend struct {
	runtimebackend.Backend
	descriptor runtimebackend.Descriptor
}

func (backend *pinnedDescriptorBackend) Descriptor() runtimebackend.Descriptor {
	return cloneRegisteredDescriptor(backend.descriptor)
}

func (backend *pinnedDescriptorBackend) Execute(ctx context.Context, request runtimebackend.ExecutionRequest) (runtimebackend.ExecutionResult, error) {
	if !backend.descriptor.Capabilities.Execute {
		return runtimebackend.ExecutionResult{}, runtimebackend.ErrCapabilityUnavailable
	}
	return backend.Backend.(runtimebackend.Executor).Execute(ctx, request)
}

func (backend *pinnedDescriptorBackend) ExecuteStream(ctx context.Context, request runtimebackend.ExecutionRequest, emit runtimebackend.EmitFunc) (runtimebackend.ExecutionSummary, error) {
	if !backend.descriptor.Capabilities.Stream {
		return runtimebackend.ExecutionSummary{}, runtimebackend.ErrCapabilityUnavailable
	}
	return backend.Backend.(runtimebackend.StreamExecutor).ExecuteStream(ctx, request, emit)
}

func (backend *pinnedDescriptorBackend) Cancel(ctx context.Context, request runtimebackend.CancelRequest) error {
	if !backend.descriptor.Capabilities.Cancel {
		return runtimebackend.ErrCapabilityUnavailable
	}
	return backend.Backend.(runtimebackend.Canceller).Cancel(ctx, request)
}

func verifyAdvertisedInterfaces(backend runtimebackend.Backend, capabilities runtimebackend.Capabilities) error {
	if capabilities.Execute {
		if _, ok := backend.(runtimebackend.Executor); !ok {
			return ErrDescriptorMismatch
		}
	}
	if capabilities.Stream {
		if _, ok := backend.(runtimebackend.StreamExecutor); !ok {
			return ErrDescriptorMismatch
		}
	}
	if capabilities.Cancel {
		if _, ok := backend.(runtimebackend.Canceller); !ok {
			return ErrDescriptorMismatch
		}
	}
	return nil
}

func cloneRegisteredDescriptor(source runtimebackend.Descriptor) runtimebackend.Descriptor {
	descriptor := source
	descriptor.Accelerators = append([]runtimebackend.AcceleratorConstraint{}, source.Accelerators...)
	descriptor.Provenance.ArtifactSHA256 = make(map[string]string, len(source.Provenance.ArtifactSHA256))
	for platform, digest := range source.Provenance.ArtifactSHA256 {
		descriptor.Provenance.ArtifactSHA256[platform] = digest
	}
	descriptor.Provenance.ContainerImages = append([]string{}, source.Provenance.ContainerImages...)
	return descriptor
}

// NewStaticRegistry creates the immutable public registry from an explicit
// compile-time list. A caller that wants to add a backend must import its Go
// package and add a Registration at the call site.
func NewStaticRegistry(registrations ...Registration) (*runtimebackend.Registry, error) {
	if len(registrations) == 0 || len(registrations) > 64 {
		return nil, ErrInvalidManifest
	}
	backends := make([]runtimebackend.Backend, 0, len(registrations))
	seen := make(map[string]struct{}, len(registrations))
	for index, registration := range registrations {
		if nilBackend(registration.Backend) {
			return nil, fmt.Errorf("static runtime registration %d: %w", index, ErrDescriptorMismatch)
		}
		if err := registration.Manifest.Validate(); err != nil {
			return nil, fmt.Errorf("static runtime registration %d: %w", index, err)
		}
		descriptor := cloneRegisteredDescriptor(registration.Backend.Descriptor())
		if err := verifyRegisteredDescriptor(registration.Manifest, descriptor); err != nil {
			return nil, fmt.Errorf("static runtime registration %d: %w", index, err)
		}
		if err := verifyAdvertisedInterfaces(registration.Backend, descriptor.Capabilities); err != nil {
			return nil, fmt.Errorf("static runtime registration %d: %w", index, err)
		}
		if _, duplicate := seen[registration.Manifest.BackendID]; duplicate {
			return nil, ErrInvalidManifest
		}
		seen[registration.Manifest.BackendID] = struct{}{}
		backends = append(backends, &pinnedDescriptorBackend{Backend: registration.Backend, descriptor: descriptor})
	}
	registry, err := runtimebackend.NewRegistry(backends...)
	if err != nil {
		if errors.Is(err, runtimebackend.ErrInvalid) {
			return nil, ErrDescriptorMismatch
		}
		return nil, err
	}
	// Re-attest the snapshots stored by the generic registry. Each wrapper above
	// returns the one descriptor captured together with its concrete instance,
	// so registrations cannot swap identities between separate reads.
	for index, registration := range registrations {
		descriptor, found := registry.Descriptor(registration.Manifest.BackendID)
		if !found {
			return nil, fmt.Errorf("static runtime registration %d: %w", index, ErrDescriptorMismatch)
		}
		if err := verifyRegisteredDescriptor(registration.Manifest, descriptor); err != nil {
			return nil, fmt.Errorf("static runtime registration %d: %w", index, err)
		}
	}
	return registry, nil
}
