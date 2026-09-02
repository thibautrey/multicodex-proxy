package runtimebackend

import "errors"

var (
	// ErrInvalid marks malformed contracts, descriptors, grants and requests.
	ErrInvalid = errors.New("runtime backend contract is invalid")
	// ErrIncompatible means no registered backend satisfies the request.
	ErrIncompatible = errors.New("runtime backend is incompatible")
	// ErrCapabilityUnavailable means an optional capability was not declared.
	ErrCapabilityUnavailable = errors.New("runtime backend capability is unavailable")
	// ErrExecutionDisabled means execution is forbidden by the backend policy.
	ErrExecutionDisabled = errors.New("runtime backend execution is disabled")
	// ErrOutOfMemory is the stable backend-neutral out-of-memory classification.
	ErrOutOfMemory = errors.New("runtime backend exhausted memory")
	// ErrCrashed is the stable backend-neutral runtime-crash classification.
	ErrCrashed = errors.New("runtime backend crashed")
	// ErrTimedOut is the stable backend-neutral timeout classification.
	ErrTimedOut = errors.New("runtime backend timed out")
	// ErrCancelled is the stable backend-neutral cancellation classification.
	ErrCancelled = errors.New("runtime backend execution was cancelled")
	// ErrExecutionUnknown means an execution ID was valid but is not active.
	ErrExecutionUnknown = errors.New("runtime backend execution is unknown")
	// ErrGrantMismatch means an active execution belongs to another grant ID or
	// policy revision. It reveals no owner details.
	ErrGrantMismatch = errors.New("runtime backend execution grant does not match")
	// ErrGrantExpired means a structurally valid operation grant is not current.
	ErrGrantExpired = errors.New("runtime backend operation grant is expired")
	// ErrBackendFailure is a backend-neutral lifecycle or model-operation failure.
	// Adapters use it instead of exposing private command output or local paths.
	ErrBackendFailure = errors.New("runtime backend operation failed")
)
