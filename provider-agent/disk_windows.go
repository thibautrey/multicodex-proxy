//go:build windows

package main

import (
	"errors"
	"syscall"
	"unsafe"
)

var getDiskFreeSpaceExW = syscall.NewLazyDLL("kernel32.dll").NewProc("GetDiskFreeSpaceExW")

func providerFreeDiskBytes(path string) (uint64, error) {
	widePath, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, errors.New("provider model storage path is invalid")
	}
	var freeBytes uint64
	var totalBytes uint64
	var totalFreeBytes uint64
	result, _, callErr := getDiskFreeSpaceExW.Call(
		uintptr(unsafe.Pointer(widePath)),
		uintptr(unsafe.Pointer(&freeBytes)),
		uintptr(unsafe.Pointer(&totalBytes)),
		uintptr(unsafe.Pointer(&totalFreeBytes)),
	)
	if result == 0 || callErr != syscall.Errno(0) || freeBytes == 0 {
		return 0, errors.New("provider model storage capacity is unavailable")
	}
	return freeBytes, nil
}
