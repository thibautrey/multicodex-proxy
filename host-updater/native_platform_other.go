//go:build !windows

package main

import "errors"

func nativePowerShellPath() (string, error) {
	return "", errors.New("Windows PowerShell is unavailable")
}
