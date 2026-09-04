//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

const (
	providerMoveFileReplaceExisting = 0x00000001
	providerMoveFileWriteThrough    = 0x00000008
)

var providerKernel32 = syscall.NewLazyDLL("kernel32.dll")
var providerMoveFileEx = providerKernel32.NewProc("MoveFileExW")

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
	if err := replaceProviderFile(temporaryPath, path); err != nil {
		return err
	}
	remove = false
	return nil
}

func replaceProviderFile(source, destination string) error {
	sourcePath, err := syscall.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	destinationPath, err := syscall.UTF16PtrFromString(destination)
	if err != nil {
		return err
	}
	result, _, callErr := providerMoveFileEx.Call(
		uintptr(unsafe.Pointer(sourcePath)), uintptr(unsafe.Pointer(destinationPath)),
		providerMoveFileReplaceExisting|providerMoveFileWriteThrough,
	)
	if result != 0 {
		return nil
	}
	if callErr != syscall.Errno(0) {
		return callErr
	}
	return errors.New("Windows could not atomically replace the provider state file")
}
