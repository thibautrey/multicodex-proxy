//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
)

func nativePowerShellPath() (string, error) {
	systemRoot := os.Getenv("SystemRoot")
	if !filepath.IsAbs(systemRoot) {
		return "", errors.New("SystemRoot is unavailable")
	}
	path := filepath.Join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", errors.New("Windows PowerShell is unavailable")
	}
	return path, nil
}
