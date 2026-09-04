//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

const (
	startupRunSubKey   = `Software\Microsoft\Windows\CurrentVersion\Run`
	startupValueName   = "MultiVibe Host"
	startupKeyRead     = 0x20019
	startupKeyWrite    = 0x20006
	startupKeyCreate   = 0xF003F
	startupValueString = 1
	startupNotFound    = syscall.Errno(2)
)

var (
	startupAdvapi32       = syscall.NewLazyDLL("advapi32.dll")
	startupRegCreateKeyEx = startupAdvapi32.NewProc("RegCreateKeyExW")
	startupRegSetValueEx  = startupAdvapi32.NewProc("RegSetValueExW")
	startupRegDeleteValue = startupAdvapi32.NewProc("RegDeleteValueW")
)

func startAtLoginEnabled() bool {
	key, err := openStartupKey(startupKeyRead)
	if err != nil {
		return false
	}
	defer syscall.RegCloseKey(key)
	name, err := syscall.UTF16PtrFromString(startupValueName)
	if err != nil {
		return false
	}
	var valueType uint32
	var valueSize uint32
	if err := syscall.RegQueryValueEx(key, name, nil, &valueType, nil, &valueSize); err != nil ||
		(valueType != startupValueString && valueType != 2) || valueSize < 2 || valueSize > 32*1024 {
		return false
	}
	buffer := make([]byte, valueSize)
	if err := syscall.RegQueryValueEx(key, name, nil, &valueType, &buffer[0], &valueSize); err != nil {
		return false
	}
	value := syscall.UTF16ToString((*[1 << 15]uint16)(unsafe.Pointer(&buffer[0]))[:valueSize/2])
	return strings.TrimSpace(value) != ""
}

func setStartAtLogin(enabled bool) error {
	key, err := openStartupKey(startupKeyWrite)
	if err != nil && enabled {
		key, err = createStartupKey()
	}
	if err != nil {
		return err
	}
	defer syscall.RegCloseKey(key)
	name, err := syscall.UTF16PtrFromString(startupValueName)
	if err != nil {
		return err
	}
	if !enabled {
		result, _, _ := startupRegDeleteValue.Call(uintptr(key), uintptr(unsafe.Pointer(name)))
		if result == uintptr(startupNotFound) {
			return nil
		}
		if result != 0 {
			return syscall.Errno(result)
		}
		return nil
	}
	executable, err := os.Executable()
	if err != nil || !filepath.IsAbs(executable) {
		return errors.New("the menu executable path is unavailable")
	}
	command := `"` + strings.ReplaceAll(executable, `"`, `\"`) + `"`
	encoded := syscall.StringToUTF16(command)
	result, _, _ := startupRegSetValueEx.Call(
		uintptr(key), uintptr(unsafe.Pointer(name)), 0, startupValueString,
		uintptr(unsafe.Pointer(&encoded[0])), uintptr(len(encoded)*2),
	)
	if result != 0 {
		return syscall.Errno(result)
	}
	return nil
}

func openStartupKey(access uint32) (syscall.Handle, error) {
	subkey, err := syscall.UTF16PtrFromString(startupRunSubKey)
	if err != nil {
		return 0, err
	}
	var key syscall.Handle
	if err := syscall.RegOpenKeyEx(syscall.HKEY_CURRENT_USER, subkey, 0, access, &key); err != nil {
		return 0, err
	}
	return key, nil
}

func createStartupKey() (syscall.Handle, error) {
	subkey, err := syscall.UTF16PtrFromString(startupRunSubKey)
	if err != nil {
		return 0, err
	}
	var key syscall.Handle
	var disposition uint32
	result, _, callErr := startupRegCreateKeyEx.Call(
		uintptr(syscall.HKEY_CURRENT_USER), uintptr(unsafe.Pointer(subkey)), 0, 0, 0,
		startupKeyCreate, 0, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(&disposition)),
	)
	if result != 0 {
		if callErr != syscall.Errno(0) {
			return 0, callErr
		}
		return 0, syscall.Errno(result)
	}
	return key, nil
}
