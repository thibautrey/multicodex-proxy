//go:build (!linux && !windows) || (linux && !cgo)

package main

func startAtLoginEnabled() bool { return false }
