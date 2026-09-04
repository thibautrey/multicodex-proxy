//go:build !windows

package main

import "syscall"

func requestManagedOllamaStop(process managedOllamaProcess) error {
	return process.Signal(syscall.SIGTERM)
}
