//go:build !windows

package main

import "os"

func hostPrivateFile(_ string, info os.FileInfo) bool {
	return info != nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 && info.Mode().Perm() == 0o600
}

func hostPrivateDirectory(_ string, info os.FileInfo) bool {
	return info != nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0 && info.Mode().Perm() == 0o700
}

func hostExecutableFile(_ string, info os.FileInfo) bool {
	return info != nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 && info.Mode().Perm()&0o111 != 0
}

func secureHostPrivateFile(path string) error      { return os.Chmod(path, 0o600) }
func secureHostPrivateDirectory(path string) error { return os.Chmod(path, 0o700) }
