package runtimebenchmark

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const (
	StoreVersion      = "provider-runtime-benchmark-store-v1"
	defaultMaxResults = 32
	maximumStoreBytes = 1 << 20
)

type StoreDocument struct {
	SchemaVersion string   `json:"schema_version"`
	Results       []Result `json:"results"`
}

type StoreOptions struct {
	MaximumResults int
}

type Store struct {
	path           string
	maximumResults int
	mu             sync.Mutex
}

func NewStore(path string, options StoreOptions) (*Store, error) {
	maximumResults := options.MaximumResults
	if maximumResults == 0 {
		maximumResults = defaultMaxResults
	}
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || filepath.Base(path) == "." || filepath.Base(path) == string(filepath.Separator) ||
		maximumResults < 1 || maximumResults > 256 {
		return nil, ErrInvalid
	}
	return &Store{path: path, maximumResults: maximumResults}, nil
}

func (store *Store) Read() (StoreDocument, error) {
	if store == nil {
		return StoreDocument{}, ErrInvalid
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.readLocked()
}

func (store *Store) Append(result Result) error {
	if store == nil || validateResult(result) != nil {
		return ErrInvalid
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	document, err := store.readLocked()
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if errors.Is(err, os.ErrNotExist) {
		document = StoreDocument{SchemaVersion: StoreVersion, Results: []Result{}}
	}
	for _, existing := range document.Results {
		if existing.BenchmarkID == result.BenchmarkID {
			return ErrInvalid
		}
	}
	document.Results = append(document.Results, result)
	sort.Slice(document.Results, func(left, right int) bool {
		if !document.Results[left].CompletedAt.Equal(document.Results[right].CompletedAt) {
			return document.Results[left].CompletedAt.Before(document.Results[right].CompletedAt)
		}
		return document.Results[left].BenchmarkID < document.Results[right].BenchmarkID
	})
	if len(document.Results) > store.maximumResults {
		document.Results = append([]Result(nil), document.Results[len(document.Results)-store.maximumResults:]...)
	}
	raw, err := marshalStore(document)
	for err == nil && len(raw) > maximumStoreBytes && len(document.Results) > 1 {
		document.Results = append([]Result(nil), document.Results[1:]...)
		raw, err = marshalStore(document)
	}
	if err != nil || len(raw) > maximumStoreBytes {
		return ErrInvalid
	}
	return store.writeLocked(raw)
}

func (store *Store) readLocked() (StoreDocument, error) {
	info, err := os.Lstat(store.path)
	if err != nil {
		return StoreDocument{}, err
	}
	if !runtimeBenchmarkPrivateFile(store.path, info) || info.Size() < 1 || info.Size() > maximumStoreBytes {
		return StoreDocument{}, ErrInvalid
	}
	file, err := os.Open(store.path)
	if err != nil {
		return StoreDocument{}, err
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil || !os.SameFile(info, openedInfo) || !runtimeBenchmarkPrivateFile(store.path, openedInfo) {
		return StoreDocument{}, ErrInvalid
	}
	raw, err := io.ReadAll(io.LimitReader(file, maximumStoreBytes+1))
	if err != nil || len(raw) > maximumStoreBytes || validateUniqueKeys(raw) != nil {
		return StoreDocument{}, ErrInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var document StoreDocument
	if err := decoder.Decode(&document); err != nil {
		return StoreDocument{}, ErrInvalid
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return StoreDocument{}, ErrInvalid
	}
	if document.SchemaVersion != StoreVersion || len(document.Results) > store.maximumResults {
		return StoreDocument{}, ErrInvalid
	}
	previousID := ""
	var previousCompleted bool
	var previousTime = documentTimeZero
	seenIDs := make(map[string]struct{}, len(document.Results))
	for _, result := range document.Results {
		if validateResult(result) != nil {
			return StoreDocument{}, ErrInvalid
		}
		if _, duplicate := seenIDs[result.BenchmarkID]; duplicate {
			return StoreDocument{}, ErrInvalid
		}
		seenIDs[result.BenchmarkID] = struct{}{}
		if previousCompleted {
			if result.CompletedAt.Before(previousTime) || (result.CompletedAt.Equal(previousTime) && result.BenchmarkID <= previousID) {
				return StoreDocument{}, ErrInvalid
			}
		}
		previousCompleted = true
		previousTime = result.CompletedAt
		previousID = result.BenchmarkID
	}
	return document, nil
}

var documentTimeZero = func() (zeroTime time.Time) { return zeroTime }()

func marshalStore(document StoreDocument) ([]byte, error) {
	return json.MarshalIndent(document, "", "  ")
}

func (store *Store) writeLocked(raw []byte) error {
	if err := atomicWriteRuntimeBenchmarkStore(store.path, raw); err != nil {
		return err
	}
	return nil
}

func validateUniqueKeys(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := consumeValue(decoder); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return ErrInvalid
	}
	return nil
}

func consumeValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delimiter {
	case '{':
		seen := make(map[string]struct{})
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return err
			}
			key, ok := keyToken.(string)
			if !ok {
				return ErrInvalid
			}
			if _, duplicate := seen[key]; duplicate {
				return ErrInvalid
			}
			seen[key] = struct{}{}
			if err := consumeValue(decoder); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return ErrInvalid
		}
	case '[':
		for decoder.More() {
			if err := consumeValue(decoder); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim(']') {
			return ErrInvalid
		}
	default:
		return ErrInvalid
	}
	return nil
}
