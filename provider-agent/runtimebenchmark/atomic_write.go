package runtimebenchmark

import (
	"errors"
	"os"
	"path/filepath"
)

func runtimeBenchmarkPrivateDirectoryAndCheck(path string) error {
	if err := secureRuntimeBenchmarkPrivateDirectory(path); err != nil {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil || !runtimeBenchmarkPrivateDirectory(path, info) {
		return errors.New("benchmark store directory is unsafe")
	}
	return nil
}

func atomicWriteRuntimeBenchmarkStore(path string, content []byte) error {
	directory := filepath.Dir(path)
	if err := runtimeBenchmarkPrivateDirectoryAndCheck(directory); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(directory, ".multivibe-benchmark-*")
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
	if err := secureRuntimeBenchmarkPrivateFile(temporaryPath); err != nil {
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
		if !runtimeBenchmarkPrivateFile(path, destination) {
			return errors.New("benchmark store destination is unsafe")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := replaceRuntimeBenchmarkFile(temporaryPath, path); err != nil {
		return err
	}
	remove = false
	return nil
}
