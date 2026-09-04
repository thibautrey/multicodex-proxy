//go:build !windows

package main

import (
	"errors"
	"os"
	"syscall"
)

func providerPrivateFile(_ string, info os.FileInfo) bool {
	return info != nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 && info.Mode().Perm() == 0o600
}

func providerPrivateDirectory(_ string, info os.FileInfo) bool {
	return info != nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0 && info.Mode().Perm() == 0o700
}

func providerExecutableFile(_ string, info os.FileInfo) bool {
	return info != nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 &&
		info.Mode().Perm()&0o111 != 0 && info.Mode().Perm()&0o022 == 0
}

func providerManagedRuntimeFile(_ string, info os.FileInfo) bool {
	return info != nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 &&
		info.Mode().Perm()&0o022 == 0
}

func providerOwnedByCurrentUser(_ string, info os.FileInfo) bool {
	if info == nil {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && uint32(stat.Uid) == uint32(os.Geteuid())
}

func secureProviderPrivateFile(path string) error {
	return os.Chmod(path, 0o600)
}

func secureProviderPrivateDirectory(path string) error {
	return os.Chmod(path, 0o700)
}

func secureProviderExecutableFile(path string) error {
	return os.Chmod(path, 0o755)
}

func secureProviderManagedRuntimeFile(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("managed runtime file is not regular")
	}
	return os.Chmod(path, info.Mode().Perm()&^0o022)
}
