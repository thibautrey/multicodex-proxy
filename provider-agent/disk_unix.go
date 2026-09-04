//go:build darwin || linux

package main

import (
	"errors"
	"syscall"
)

func providerFreeDiskBytes(path string) (uint64, error) {
	var filesystem syscall.Statfs_t
	if err := syscall.Statfs(path, &filesystem); err != nil || filesystem.Bsize <= 0 {
		return 0, errors.New("provider model storage capacity is unavailable")
	}
	freeBytes, ok := checkedMultiply(uint64(filesystem.Bavail), uint64(filesystem.Bsize))
	if !ok {
		return 0, errors.New("provider model storage capacity is invalid")
	}
	return freeBytes, nil
}
