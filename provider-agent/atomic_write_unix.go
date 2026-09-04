//go:build !windows

package main

import (
	"errors"
	"os"
	"path/filepath"
)

func atomicWrite0600(path string, content []byte) error {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return err
	}
	if err := secureProviderPrivateDirectory(directory); err != nil {
		return err
	}
	info, err := os.Lstat(directory)
	if err != nil || !providerPrivateDirectory(directory, info) {
		return errors.New("state directory is invalid")
	}
	temporary, err := os.CreateTemp(directory, ".multivibe-provider-state-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	remove := true
	defer func() {
		_ = temporary.Close()
		if remove {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := secureProviderPrivateFile(temporaryPath); err != nil {
		return err
	}
	if _, err := temporary.Write(content); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if destination, err := os.Lstat(path); err == nil {
		if !providerPrivateFile(path, destination) {
			return errors.New("state destination is unsafe")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	remove = false
	directoryHandle, err := os.Open(directory)
	if err != nil {
		return err
	}
	if err := directoryHandle.Sync(); err != nil {
		_ = directoryHandle.Close()
		return err
	}
	return directoryHandle.Close()
}
