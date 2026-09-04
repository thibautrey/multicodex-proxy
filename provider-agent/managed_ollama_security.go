package main

import (
	"errors"
	"os"
	"path/filepath"
)

func secureManagedOllamaTree(root, binaryPath string) error {
	rootInfo, err := os.Lstat(root)
	if err != nil || !providerPrivateDirectory(root, rootInfo) {
		return errors.New("managed Ollama runtime root cannot be secured")
	}
	return filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root {
			return nil
		}
		info, err := entry.Info()
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("managed Ollama runtime tree contains an unsafe link")
		}
		if info.IsDir() {
			if err := secureProviderPrivateDirectory(path); err != nil {
				return err
			}
			return nil
		}
		if !info.Mode().IsRegular() {
			return errors.New("managed Ollama runtime tree contains an unsupported entry")
		}
		if err := secureProviderManagedRuntimeFile(path); err != nil {
			return err
		}
		if path == binaryPath {
			return secureProviderExecutableFile(path)
		}
		return nil
	})
}
