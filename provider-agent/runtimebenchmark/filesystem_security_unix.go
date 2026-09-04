//go:build !windows

package runtimebenchmark

import (
	"os"
	"syscall"
)

func runtimeBenchmarkPrivateFile(_ string, info os.FileInfo) bool {
	return info != nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 && info.Mode().Perm() == 0o600 &&
		runtimeBenchmarkOwnedByCurrentUser(info)
}

func runtimeBenchmarkPrivateDirectory(_ string, info os.FileInfo) bool {
	return info != nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0 && info.Mode().Perm() == 0o700 &&
		runtimeBenchmarkOwnedByCurrentUser(info)
}

func runtimeBenchmarkOwnedByCurrentUser(info os.FileInfo) bool {
	if info == nil {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && uint32(stat.Uid) == uint32(os.Geteuid())
}

func secureRuntimeBenchmarkPrivateFile(path string) error {
	return os.Chmod(path, 0o600)
}

func secureRuntimeBenchmarkPrivateDirectory(path string) error {
	return os.Chmod(path, 0o700)
}

func replaceRuntimeBenchmarkFile(source, destination string) error {
	return os.Rename(source, destination)
}
