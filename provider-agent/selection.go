package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

const selectionSchemaVersion = "provider-selection-v1"

var errInvalidSelectedModels = errors.New("selected model allowlist is invalid")

type selectionDocument struct {
	SchemaVersion  string   `json:"schema_version"`
	Revision       uint64   `json:"revision"`
	State          string   `json:"state"`
	SelectedModels []string `json:"selected_models"`
}

type selectionStore struct {
	mu       sync.RWMutex
	path     string
	revision uint64
	models   []string
}

func normalizeSelectedModels(models []string) ([]string, error) {
	if models == nil || len(models) > 100 {
		return nil, errInvalidSelectedModels
	}
	values := append([]string{}, models...)
	seen := make(map[string]struct{}, len(values))
	for _, model := range values {
		if !validSelectedModelID(model) {
			return nil, fmt.Errorf("%w: invalid id", errInvalidSelectedModels)
		}
		if _, exists := seen[model]; exists {
			return nil, fmt.Errorf("%w: duplicate ids", errInvalidSelectedModels)
		}
		seen[model] = struct{}{}
	}
	sort.Strings(values)
	return values, nil
}

func newMemorySelectionStore(models []string) *selectionStore {
	values, err := normalizeSelectedModels(models)
	if err != nil {
		panic(err)
	}
	return &selectionStore{revision: 1, models: values}
}

func openSelectionStore(path string, initial []string) (*selectionStore, error) {
	values, err := normalizeSelectedModels(initial)
	if err != nil {
		return nil, err
	}
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("provider selection state path must be a clean absolute path")
	}
	store := &selectionStore{path: path, revision: 1, models: values}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		if err := store.persistLocked(); err != nil {
			return nil, err
		}
		return store, nil
	}
	if err != nil {
		return nil, errors.New("provider selection state cannot be inspected")
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 || info.Size() > 64*1024 {
		return nil, errors.New("provider selection state must be a bounded mode-0600 regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, errors.New("provider selection state cannot be opened")
	}
	defer file.Close()
	var document selectionDocument
	decoder := json.NewDecoder(io.LimitReader(file, 64*1024+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil || document.SchemaVersion != selectionSchemaVersion || document.Revision < 1 {
		return nil, errors.New("provider selection state is invalid")
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return nil, errors.New("provider selection state is invalid")
	}
	values, err = normalizeSelectedModels(document.SelectedModels)
	if err != nil || document.State != string(selectedManifestState(values)) {
		return nil, errors.New("provider selection state is invalid")
	}
	store.revision = document.Revision
	store.models = values
	return store, nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("unexpected trailing JSON")
	}
	return nil
}

func (store *selectionStore) snapshot() selectionDocument {
	store.mu.RLock()
	defer store.mu.RUnlock()
	return store.documentLocked()
}

func (store *selectionStore) documentLocked() selectionDocument {
	models := append([]string{}, store.models...)
	return selectionDocument{
		SchemaVersion:  selectionSchemaVersion,
		Revision:       store.revision,
		State:          string(selectedManifestState(models)),
		SelectedModels: models,
	}
}

func (store *selectionStore) replace(expectedRevision uint64, models []string) (selectionDocument, bool, error) {
	values, err := normalizeSelectedModels(models)
	if err != nil {
		return selectionDocument{}, false, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if expectedRevision != store.revision {
		return store.documentLocked(), true, nil
	}
	previousModels := store.models
	previousRevision := store.revision
	store.revision++
	store.models = values
	if store.path != "" {
		if err := store.persistLocked(); err != nil {
			store.revision = previousRevision
			store.models = previousModels
			return selectionDocument{}, false, err
		}
	}
	return store.documentLocked(), false, nil
}

func (store *selectionStore) persistLocked() error {
	directory := filepath.Dir(store.path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return errors.New("provider selection state directory cannot be created")
	}
	directoryInfo, err := os.Lstat(directory)
	if err != nil || !directoryInfo.IsDir() || directoryInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("provider selection state directory is invalid")
	}
	temporary, err := os.CreateTemp(directory, "."+filepath.Base(store.path)+".*.tmp")
	if err != nil {
		return errors.New("provider selection state temporary file cannot be created")
	}
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		_ = os.Remove(temporary.Name())
		return errors.New("provider selection state temporary file cannot be secured")
	}
	temporaryPath := temporary.Name()
	removeTemporary := true
	defer func() {
		_ = temporary.Close()
		if removeTemporary {
			_ = os.Remove(temporaryPath)
		}
	}()
	encoder := json.NewEncoder(temporary)
	encoder.SetEscapeHTML(true)
	if err := encoder.Encode(store.documentLocked()); err != nil {
		return errors.New("provider selection state cannot be encoded")
	}
	if err := temporary.Sync(); err != nil {
		return errors.New("provider selection state cannot be synchronized")
	}
	if err := temporary.Close(); err != nil {
		return errors.New("provider selection state cannot be closed")
	}
	if destination, err := os.Lstat(store.path); err == nil {
		if !destination.Mode().IsRegular() || destination.Mode().Perm() != 0o600 {
			return errors.New("provider selection state destination is unsafe")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return errors.New("provider selection state destination cannot be inspected")
	}
	if err := os.Rename(temporaryPath, store.path); err != nil {
		return fmt.Errorf("provider selection state cannot be committed: %w", err)
	}
	removeTemporary = false
	return nil
}
