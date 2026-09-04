//go:build !windows

package main

import "os"

func updaterPrivateFile(_ string, info os.FileInfo) bool {
	return info != nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 && info.Mode().Perm() == 0o600
}

func updaterPrivateDirectory(_ string, info os.FileInfo) bool {
	return info != nil && info.IsDir() && info.Mode()&os.ModeSymlink == 0 && info.Mode().Perm() == 0o700
}

func secureUpdaterPrivateFile(path string) error          { return os.Chmod(path, 0o600) }
func secureUpdaterPrivateDirectory(path string) error     { return os.Chmod(path, 0o700) }
func replaceUpdaterFile(source, destination string) error { return os.Rename(source, destination) }
