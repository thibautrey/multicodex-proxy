package runtimebackend

// launchPolicy is intentionally private to the registry implementation. It is
// the only suitable home for executable paths, argv templates, environment
// allowlists and local device bindings. Public registration never accepts
// these values from profiles or network input.
type launchPolicy struct {
	executableRelativePaths map[string]string
	argumentTemplates       [][]string
	environmentAllowlist    []string
	deviceBindings          []string
}

// MarshalJSON makes accidental serialization fail rather than yielding launch
// material. The unexported type is also absent from Descriptor.
func (launchPolicy) MarshalJSON() ([]byte, error) {
	return nil, ErrInvalid
}
