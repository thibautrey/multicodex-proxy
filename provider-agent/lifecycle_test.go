package main

import "testing"

func TestLifecycleCannotSkipApproval(t *testing.T) {
	if transition(StateDetected, StateApproved) == nil {
		t.Fatal("detected must not skip selected and submitted")
	}
	if err := transition(StateDetected, StateSelected); err != nil {
		t.Fatal(err)
	}
	if err := transition(StateOnline, StateSuspended); err != nil {
		t.Fatal(err)
	}
	if transition(StateRevoked, StateOnline) == nil {
		t.Fatal("revocation must be terminal")
	}
}
