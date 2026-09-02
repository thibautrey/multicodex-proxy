package exampleadapter

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/thibautrey/multivibe/provider-agent/runtimebackend"
	"github.com/thibautrey/multivibe/provider-agent/runtimebackend/contracttest"
)

func TestExampleAdapterSatisfiesPublicContract(t *testing.T) {
	backend, err := New(ReferenceConfig())
	if err != nil {
		t.Fatal(err)
	}
	contracttest.Run(t, backend, contracttest.DefaultFixture(time.Now()))
}

func TestExampleAdapterRejectsUnreviewedConfiguration(t *testing.T) {
	config := ReferenceConfig()
	config.Provenance.SourceURL = "file:///tmp/runtime"
	if _, err := New(config); err == nil {
		t.Fatal("local runtime provenance was accepted")
	}
	config = ReferenceConfig()
	config.Accelerators[0].Profile = "../../device"
	if _, err := New(config); err == nil {
		t.Fatal("unsafe accelerator profile was accepted")
	}
}

func TestExampleAdapterDirectStopRejectsOtherRuntimeOwnersWithoutMutation(t *testing.T) {
	backend, err := New(ReferenceConfig())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	grant := contracttest.DefaultFixture(now).Grant
	grant.PolicyRevision = 2
	ctx := context.Background()
	if _, err := backend.Prepare(ctx, grant); err != nil {
		t.Fatal(err)
	}
	if _, err := backend.Start(ctx, grant); err != nil {
		t.Fatal(err)
	}

	otherID := grant
	otherID.ID += "-other"
	staleRevision := grant
	staleRevision.PolicyRevision--
	oppositeClass := grant
	oppositeClass.TrafficClass = runtimebackend.TrafficClassCustomer
	for name, candidate := range map[string]runtimebackend.OperationGrant{
		"other grant ID":         otherID,
		"stale policy revision":  staleRevision,
		"opposite traffic class": oppositeClass,
	} {
		t.Run(name, func(t *testing.T) {
			if err := backend.Stop(ctx, candidate); !errors.Is(err, runtimebackend.ErrGrantMismatch) {
				t.Fatalf("direct stop crossed runtime ownership: %v", err)
			}
			health, err := backend.Health(ctx, grant)
			if err != nil || !health.Running {
				t.Fatalf("rejected stop mutated runtime health: %#v %v", health, err)
			}
		})
	}

	if err := backend.Cleanup(ctx, runtimebackend.CleanupRequest{Grant: grant, StopRuntime: true}); err != nil {
		t.Fatalf("owner cleanup regressed after refused direct stops: %v", err)
	}
	health, err := backend.Health(ctx, grant)
	if err != nil || health.Running {
		t.Fatalf("owner cleanup did not stop runtime: %#v %v", health, err)
	}
}
