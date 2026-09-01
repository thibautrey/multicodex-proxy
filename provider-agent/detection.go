package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"time"
)

const detectedModelsSchemaVersion = "provider-detected-models-v1"

type detectedRuntime struct {
	AdapterID string   `json:"adapter_id"`
	Models    []string `json:"models"`
}

type detectedModelsDocument struct {
	SchemaVersion string            `json:"schema_version"`
	Runtimes      []detectedRuntime `json:"runtimes"`
}

type modelCatalogPayload struct {
	Data []struct {
		ID string `json:"id"`
	} `json:"data"`
}

func detectedModels(ctx context.Context, registry adapterRegistryDocument, client *http.Client) detectedModelsDocument {
	document := detectedModelsDocument{
		SchemaVersion: detectedModelsSchemaVersion,
		Runtimes:      []detectedRuntime{},
	}
	for _, adapter := range registry.Adapters {
		for _, candidate := range adapter.Candidates {
			models, err := probeRuntimeCatalog(ctx, adapter, candidate, client)
			if err != nil {
				continue
			}
			document.Runtimes = append(document.Runtimes, detectedRuntime{
				AdapterID: adapter.ID,
				Models:    models,
			})
			break
		}
	}
	return document
}

func probeRuntimeCatalog(ctx context.Context, adapter runtimeAdapter, candidate adapterCandidate, client *http.Client) ([]string, error) {
	if err := validateLoopbackCandidate(adapter, candidate); err != nil {
		return nil, err
	}
	if client == nil {
		return nil, errors.New("provider runtime probe requires an HTTP client")
	}
	probeContext, cancel := context.WithTimeout(ctx, time.Duration(adapter.Limits.TimeoutMS)*time.Millisecond)
	defer cancel()
	request, err := http.NewRequestWithContext(probeContext, http.MethodGet, candidate.CatalogURL, nil)
	if err != nil {
		return nil, errors.New("provider runtime catalog request is invalid")
	}
	request.Header.Set("accept", "application/json")
	probeClient := *client
	probeClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	response, err := probeClient.Do(request)
	if err != nil {
		return nil, errors.New("provider runtime catalog is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, errors.New("provider runtime catalog returned a non-success status")
	}
	if response.ContentLength > int64(adapter.Limits.MaxResponseBytes) {
		return nil, errors.New("provider runtime catalog response is too large")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, int64(adapter.Limits.MaxResponseBytes)+1))
	if err != nil || len(body) > adapter.Limits.MaxResponseBytes {
		return nil, errors.New("provider runtime catalog response is too large")
	}
	var payload modelCatalogPayload
	if err := json.Unmarshal(body, &payload); err != nil || len(payload.Data) == 0 || len(payload.Data) > adapter.Limits.MaxCatalogModels {
		return nil, errors.New("provider runtime catalog payload is invalid")
	}
	models := make([]string, 0, len(payload.Data))
	seen := make(map[string]struct{}, len(payload.Data))
	for _, entry := range payload.Data {
		if !validSelectedModelID(entry.ID) {
			return nil, errors.New("provider runtime catalog contains an invalid model id")
		}
		if _, exists := seen[entry.ID]; exists {
			continue
		}
		seen[entry.ID] = struct{}{}
		models = append(models, entry.ID)
	}
	sort.Strings(models)
	return models, nil
}
