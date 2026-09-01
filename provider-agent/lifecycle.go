package main

import "fmt"

type LifecycleState string

const (
	StateDetected             LifecycleState = "detected"
	StateSelected             LifecycleState = "selected"
	StateSubmitted            LifecycleState = "submitted"
	StateApproved             LifecycleState = "approved"
	StateOnline               LifecycleState = "online"
	StateCompensationEligible LifecycleState = "compensation-eligible"
	StateSuspended            LifecycleState = "suspended"
	StateRevoked              LifecycleState = "revoked"
)

var nextState = map[LifecycleState]LifecycleState{
	StateDetected:  StateSelected,
	StateSelected:  StateSubmitted,
	StateSubmitted: StateApproved,
	StateApproved:  StateOnline,
	StateOnline:    StateCompensationEligible,
}

func transition(current, target LifecycleState) error {
	if target == StateSuspended || target == StateRevoked {
		return nil
	}
	if current == StateSuspended || current == StateRevoked || nextState[current] != target {
		return fmt.Errorf("invalid lifecycle transition from %s to %s", current, target)
	}
	return nil
}
