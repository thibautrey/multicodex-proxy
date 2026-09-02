package runtimebenchmark

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
)

const maximumSpecBytes = 64 << 10

func LoadSpec(path string) (Spec, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return Spec{}, ErrInvalid
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() < 1 || info.Size() > maximumSpecBytes {
		return Spec{}, ErrInvalid
	}
	file, err := os.Open(path)
	if err != nil {
		return Spec{}, err
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, maximumSpecBytes+1))
	if err != nil || len(raw) > maximumSpecBytes {
		return Spec{}, ErrInvalid
	}
	return DecodeSpec(raw)
}

func DecodeSpec(raw []byte) (Spec, error) {
	if len(raw) < 2 || len(raw) > maximumSpecBytes || validateUniqueKeys(raw) != nil {
		return Spec{}, ErrInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var spec Spec
	if err := decoder.Decode(&spec); err != nil {
		return Spec{}, ErrInvalid
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) || validateSpec(spec) != nil {
		return Spec{}, ErrInvalid
	}
	return spec, nil
}
