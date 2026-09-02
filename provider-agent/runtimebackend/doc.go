// Package runtimebackend defines the stable, runtime-neutral contract used by
// MultiVibe provider workers.
//
// A Backend owns lifecycle, model loading, health, readiness, metrics and
// cleanup. Execution, streaming and explicit cancellation are deliberately
// separate optional interfaces. Registry construction verifies that every
// advertised optional capability is implemented before the backend can be
// selected.
//
// Descriptors contain only public compatibility metadata. Executable paths,
// argument vectors, environment variables and local device identifiers belong
// to an adapter's private launch policy and must never be placed in a
// Descriptor. Registries are immutable snapshots: adding or replacing a
// backend requires constructing a new Registry.
package runtimebackend
