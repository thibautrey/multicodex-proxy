package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode"
)

const runtimeEndpointsSchemaVersion = "provider-runtime-endpoints-v1"

var errInvalidRuntimeEndpoints = errors.New("provider runtime endpoints are invalid")

type runtimeEndpoint struct {
	AdapterID   string `json:"adapter_id"`
	Endpoint    string `json:"endpoint"`
	BearerToken string `json:"bearer_token,omitempty"`
}

type runtimeEndpointInput struct {
	AdapterID   string  `json:"adapter_id"`
	Endpoint    string  `json:"endpoint"`
	BearerToken *string `json:"bearer_token,omitempty"`
}

type runtimeEndpointView struct {
	AdapterID      string `json:"adapter_id"`
	Endpoint       string `json:"endpoint"`
	Authentication string `json:"authentication"`
}

type runtimeEndpointsStateDocument struct {
	SchemaVersion string            `json:"schema_version"`
	Revision      uint64            `json:"revision"`
	Endpoints     []runtimeEndpoint `json:"endpoints"`
}

type runtimeEndpointsViewDocument struct {
	SchemaVersion string                `json:"schema_version"`
	Revision      uint64                `json:"revision"`
	Endpoints     []runtimeEndpointView `json:"endpoints"`
}

type runtimeEndpointStore struct {
	mu        sync.RWMutex
	path      string
	revision  uint64
	endpoints []runtimeEndpoint
}

func normalizeRuntimeEndpoints(endpoints []runtimeEndpoint, registry adapterRegistryDocument) ([]runtimeEndpoint, error) {
	if endpoints == nil || len(endpoints) > len(registry.Adapters) {
		return nil, errInvalidRuntimeEndpoints
	}
	adapters := make(map[string]runtimeAdapter, len(registry.Adapters))
	for _, adapter := range registry.Adapters {
		adapters[adapter.ID] = adapter
	}
	values := append([]runtimeEndpoint{}, endpoints...)
	seen := make(map[string]struct{}, len(values))
	for index := range values {
		value := &values[index]
		adapter, exists := adapters[value.AdapterID]
		if !exists || len(adapter.Candidates) != 0 {
			return nil, fmt.Errorf("%w: adapter is not manually configurable", errInvalidRuntimeEndpoints)
		}
		if _, duplicate := seen[value.AdapterID]; duplicate {
			return nil, fmt.Errorf("%w: duplicate adapter", errInvalidRuntimeEndpoints)
		}
		seen[value.AdapterID] = struct{}{}
		parsed, err := url.Parse(value.Endpoint)
		if err != nil {
			return nil, fmt.Errorf("%w: endpoint must be literal loopback HTTP with an explicit port", errInvalidRuntimeEndpoints)
		}
		host := strings.TrimPrefix(strings.TrimSuffix(parsed.Hostname(), "]"), "[")
		port := parsed.Port()
		if parsed.Scheme != "http" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" ||
			(host != "127.0.0.1" && host != "::1") || port == "" || (parsed.Path != "" && parsed.Path != "/") || parsed.RawPath != "" {
			return nil, fmt.Errorf("%w: endpoint must be literal loopback HTTP with an explicit port", errInvalidRuntimeEndpoints)
		}
		portNumber, err := strconv.Atoi(port)
		if err != nil || portNumber < 1 || portNumber > 65535 {
			return nil, fmt.Errorf("%w: endpoint port is invalid", errInvalidRuntimeEndpoints)
		}
		value.Endpoint = "http://" + net.JoinHostPort(host, port)
		if len(value.BearerToken) > 4096 {
			return nil, fmt.Errorf("%w: bearer token is too large", errInvalidRuntimeEndpoints)
		}
		for _, character := range value.BearerToken {
			if unicode.IsControl(character) {
				return nil, fmt.Errorf("%w: bearer token contains control characters", errInvalidRuntimeEndpoints)
			}
		}
		if adapter.Authentication == "none" && value.BearerToken != "" {
			return nil, fmt.Errorf("%w: adapter does not accept authentication", errInvalidRuntimeEndpoints)
		}
	}
	sort.Slice(values, func(left, right int) bool { return values[left].AdapterID < values[right].AdapterID })
	return values, nil
}

func newMemoryRuntimeEndpointStore() *runtimeEndpointStore {
	return &runtimeEndpointStore{revision: 1, endpoints: []runtimeEndpoint{}}
}

func openRuntimeEndpointStore(path string, registry adapterRegistryDocument) (*runtimeEndpointStore, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("provider runtime state path must be a clean absolute path")
	}
	store := &runtimeEndpointStore{path: path, revision: 1, endpoints: []runtimeEndpoint{}}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		if err := store.persistLocked(); err != nil {
			return nil, err
		}
		return store, nil
	}
	if err != nil {
		return nil, errors.New("provider runtime state cannot be inspected")
	}
	if !providerPrivateFile(path, info) || info.Size() > 64*1024 {
		return nil, errors.New("provider runtime state must be a bounded mode-0600 regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, errors.New("provider runtime state cannot be opened")
	}
	defer file.Close()
	var document runtimeEndpointsStateDocument
	decoder := json.NewDecoder(io.LimitReader(file, 64*1024+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil || ensureJSONEOF(decoder) != nil ||
		document.SchemaVersion != runtimeEndpointsSchemaVersion || document.Revision < 1 {
		return nil, errors.New("provider runtime state is invalid")
	}
	values, err := normalizeRuntimeEndpoints(document.Endpoints, registry)
	if err != nil {
		return nil, errors.New("provider runtime state is invalid")
	}
	store.revision = document.Revision
	store.endpoints = values
	return store, nil
}

func (store *runtimeEndpointStore) snapshot() runtimeEndpointsViewDocument {
	store.mu.RLock()
	defer store.mu.RUnlock()
	return store.viewLocked()
}

func (store *runtimeEndpointStore) configured() []runtimeEndpoint {
	store.mu.RLock()
	defer store.mu.RUnlock()
	return append([]runtimeEndpoint{}, store.endpoints...)
}

func (store *runtimeEndpointStore) viewLocked() runtimeEndpointsViewDocument {
	views := make([]runtimeEndpointView, 0, len(store.endpoints))
	for _, endpoint := range store.endpoints {
		authentication := "none"
		if endpoint.BearerToken != "" {
			authentication = "bearer"
		}
		views = append(views, runtimeEndpointView{
			AdapterID: endpoint.AdapterID, Endpoint: endpoint.Endpoint, Authentication: authentication,
		})
	}
	return runtimeEndpointsViewDocument{SchemaVersion: runtimeEndpointsSchemaVersion, Revision: store.revision, Endpoints: views}
}

func (store *runtimeEndpointStore) replace(expectedRevision uint64, endpoints []runtimeEndpoint, registry adapterRegistryDocument) (runtimeEndpointsViewDocument, bool, error) {
	values, err := normalizeRuntimeEndpoints(endpoints, registry)
	if err != nil {
		return runtimeEndpointsViewDocument{}, false, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if expectedRevision != store.revision {
		return store.viewLocked(), true, nil
	}
	previousRevision := store.revision
	previousEndpoints := store.endpoints
	store.revision++
	store.endpoints = values
	if store.path != "" {
		if err := store.persistLocked(); err != nil {
			store.revision = previousRevision
			store.endpoints = previousEndpoints
			return runtimeEndpointsViewDocument{}, false, err
		}
	}
	return store.viewLocked(), false, nil
}

func (store *runtimeEndpointStore) replaceInputs(expectedRevision uint64, inputs []runtimeEndpointInput, registry adapterRegistryDocument) (runtimeEndpointsViewDocument, bool, error) {
	endpoints := make([]runtimeEndpoint, 0, len(inputs))
	providedSecrets := make([]bool, 0, len(inputs))
	for _, input := range inputs {
		endpoint := runtimeEndpoint{AdapterID: input.AdapterID, Endpoint: input.Endpoint}
		if input.BearerToken != nil {
			endpoint.BearerToken = *input.BearerToken
		}
		endpoints = append(endpoints, endpoint)
		providedSecrets = append(providedSecrets, input.BearerToken != nil)
	}
	values, err := normalizeRuntimeEndpoints(endpoints, registry)
	if err != nil {
		return runtimeEndpointsViewDocument{}, false, err
	}
	providedByAdapter := make(map[string]bool, len(inputs))
	for index, input := range inputs {
		providedByAdapter[input.AdapterID] = providedSecrets[index]
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if expectedRevision != store.revision {
		return store.viewLocked(), true, nil
	}
	for index := range values {
		if providedByAdapter[values[index].AdapterID] {
			continue
		}
		for _, previous := range store.endpoints {
			if previous.AdapterID == values[index].AdapterID && previous.Endpoint == values[index].Endpoint {
				values[index].BearerToken = previous.BearerToken
				break
			}
		}
	}
	previousRevision := store.revision
	previousEndpoints := store.endpoints
	store.revision++
	store.endpoints = values
	if store.path != "" {
		if err := store.persistLocked(); err != nil {
			store.revision = previousRevision
			store.endpoints = previousEndpoints
			return runtimeEndpointsViewDocument{}, false, err
		}
	}
	return store.viewLocked(), false, nil
}

func (store *runtimeEndpointStore) persistLocked() error {
	document := runtimeEndpointsStateDocument{
		SchemaVersion: runtimeEndpointsSchemaVersion,
		Revision:      store.revision,
		Endpoints:     append([]runtimeEndpoint{}, store.endpoints...),
	}
	encoded, err := json.Marshal(document)
	if err != nil || len(encoded) > 64*1024 {
		return errors.New("provider runtime state cannot be committed")
	}
	if err := atomicWrite0600(store.path, append(encoded, '\n')); err != nil {
		return errors.New("provider runtime state cannot be committed")
	}
	return nil
}
