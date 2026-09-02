package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
)

const providerModelCatalogSchemaVersion = "provider-model-catalog-v1"

var ollamaModelReference = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,63}$`)

type providerModelCatalogLicense struct {
	LicenseID              string `json:"license_id"`
	HostedInferenceAllowed bool   `json:"hosted_inference_allowed"`
	AssessmentPath         string `json:"assessment_path"`
	AssessmentDigest       string `json:"assessment_digest"`
}

type providerModelCatalogVRAM struct {
	ContextTokens         uint64 `json:"context_tokens"`
	EstimatedVRAMBytesHex string `json:"estimated_vram_bytes_hex"`
	EstimatedVRAMBytes    uint64 `json:"-"`
}

type providerModelCatalogEntry struct {
	CanonicalModelID   string                      `json:"canonical_model_id"`
	OllamaModel        string                      `json:"ollama_model"`
	OllamaManifestPath string                      `json:"ollama_manifest_path"`
	ContentDigest      string                      `json:"content_digest"`
	DownloadBytesHex   string                      `json:"download_bytes_hex"`
	DownloadBytes      uint64                      `json:"-"`
	GPUUtilization     uint8                       `json:"gpu_utilization_percent"`
	VRAMEstimates      []providerModelCatalogVRAM  `json:"vram_estimates"`
	License            providerModelCatalogLicense `json:"license"`
}

type providerModelCatalog struct {
	SchemaVersion string                      `json:"schema_version"`
	Models        []providerModelCatalogEntry `json:"models"`
}

func openProviderModelCatalog(path string) (providerModelCatalog, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return providerModelCatalog{}, errors.New("provider model catalog path must be a clean absolute path")
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() < 1 || info.Size() > 1024*1024 {
		return providerModelCatalog{}, errors.New("provider model catalog must be a bounded regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return providerModelCatalog{}, errors.New("provider model catalog cannot be opened")
	}
	defer file.Close()
	raw, err := io.ReadAll(io.LimitReader(file, 1024*1024+1))
	if err != nil || len(raw) > 1024*1024 || validateUniqueJSONKeys(raw) != nil {
		return providerModelCatalog{}, errors.New("provider model catalog is invalid")
	}
	var catalog providerModelCatalog
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&catalog) != nil || ensureJSONEOF(decoder) != nil || validateProviderModelCatalog(&catalog) != nil {
		return providerModelCatalog{}, errors.New("provider model catalog is invalid")
	}
	return catalog, nil
}

func validateProviderModelCatalog(catalog *providerModelCatalog) error {
	if catalog == nil {
		return errors.New("provider model catalog is invalid")
	}
	if catalog.SchemaVersion != providerModelCatalogSchemaVersion || len(catalog.Models) < 1 || len(catalog.Models) > maximumProviderDemandItems {
		return errors.New("provider model catalog is invalid")
	}
	previous := ""
	manifestPaths := make(map[string]struct{}, len(catalog.Models))
	ollamaModels := make(map[string]struct{}, len(catalog.Models))
	for modelIndex := range catalog.Models {
		model := &catalog.Models[modelIndex]
		downloadBytes, downloadErr := parseCatalogHexBytes(model.DownloadBytesHex)
		model.DownloadBytes = downloadBytes
		if !providerDemandModelID.MatchString(model.CanonicalModelID) || model.CanonicalModelID <= previous ||
			!ollamaModelReference.MatchString(model.OllamaModel) || !safeOllamaManifestPath(model.OllamaManifestPath) ||
			!providerDemandContentDigest.MatchString(model.ContentDigest) || downloadErr != nil || model.DownloadBytes < 1 ||
			model.DownloadBytes > maximumProviderArtifactBytes || model.GPUUtilization < 1 || model.GPUUtilization > 100 ||
			len(model.VRAMEstimates) < 1 || len(model.VRAMEstimates) > 7 ||
			!providerDemandLicenseID.MatchString(model.License.LicenseID) || !model.License.HostedInferenceAllowed ||
			!safeAssessmentPath(model.License.AssessmentPath) ||
			!providerDigest.MatchString(model.License.AssessmentDigest) {
			return errors.New("provider model catalog is invalid")
		}
		if _, exists := manifestPaths[model.OllamaManifestPath]; exists {
			return errors.New("provider model catalog is invalid")
		}
		if _, exists := ollamaModels[model.OllamaModel]; exists {
			return errors.New("provider model catalog is invalid")
		}
		manifestPaths[model.OllamaManifestPath] = struct{}{}
		ollamaModels[model.OllamaModel] = struct{}{}
		previous = model.CanonicalModelID
		previousContext := uint64(0)
		for estimateIndex := range model.VRAMEstimates {
			estimate := &model.VRAMEstimates[estimateIndex]
			estimatedBytes, estimateErr := parseCatalogHexBytes(estimate.EstimatedVRAMBytesHex)
			estimate.EstimatedVRAMBytes = estimatedBytes
			if !validDemandContextBucket(estimate.ContextTokens) || estimate.ContextTokens <= previousContext ||
				estimateErr != nil || estimate.EstimatedVRAMBytes < 1 || estimate.EstimatedVRAMBytes > maximumProviderVRAMBytes {
				return errors.New("provider model catalog is invalid")
			}
			previousContext = estimate.ContextTokens
		}
	}
	return nil
}

func safeAssessmentPath(value string) bool {
	const prefix = "provider-model-license-assessments/"
	if len(value) <= len(prefix) || len(value) > 256 || value[:len(prefix)] != prefix || filepath.IsAbs(value) ||
		filepath.Clean(value) != value || filepath.Ext(value) != ".md" {
		return false
	}
	for index := range value {
		if value[index] < 0x20 || value[index] > 0x7e || value[index] == '\\' {
			return false
		}
	}
	for _, segment := range bytes.Split([]byte(value), []byte{'/'}) {
		if len(segment) == 0 || bytes.Equal(segment, []byte(".")) || bytes.Equal(segment, []byte("..")) {
			return false
		}
	}
	return true
}

func parseCatalogHexBytes(value string) (uint64, error) {
	if len(value) < 3 || len(value) > 18 || value[:2] != "0x" {
		return 0, errors.New("catalog byte value is invalid")
	}
	return strconv.ParseUint(value[2:], 16, 64)
}

func safeOllamaManifestPath(value string) bool {
	if len(value) < 1 || len(value) > 256 || filepath.IsAbs(value) || filepath.Clean(value) != value {
		return false
	}
	for _, segment := range bytes.Split([]byte(value), []byte{'/'}) {
		if len(segment) == 0 || bytes.Equal(segment, []byte(".")) || bytes.Equal(segment, []byte("..")) {
			return false
		}
	}
	return true
}

func (catalog providerModelCatalog) entry(modelID string) (providerModelCatalogEntry, bool) {
	index := sort.Search(len(catalog.Models), func(index int) bool { return catalog.Models[index].CanonicalModelID >= modelID })
	if index >= len(catalog.Models) || catalog.Models[index].CanonicalModelID != modelID {
		return providerModelCatalogEntry{}, false
	}
	return catalog.Models[index], true
}

func (entry providerModelCatalogEntry) candidateFor(artifact providerDemandArtifact, requiredContext uint64) (modelCandidate, bool) {
	if entry.CanonicalModelID != artifact.CanonicalModelID || entry.ContentDigest != artifact.ContentDigest ||
		entry.DownloadBytes != artifact.DownloadBytes || entry.License.LicenseID != artifact.License.LicenseID ||
		entry.License.AssessmentDigest != artifact.License.AssessmentDigest || !artifact.License.HostedInferenceAllowed {
		return modelCandidate{}, false
	}
	var selected uint64
	var maximum uint64
	for _, estimate := range entry.VRAMEstimates {
		if estimate.ContextTokens == requiredContext {
			selected = estimate.EstimatedVRAMBytes
		}
		if estimate.ContextTokens > maximum {
			maximum = estimate.ContextTokens
		}
	}
	if selected == 0 {
		return modelCandidate{}, false
	}
	return modelCandidate{
		ModelID: entry.CanonicalModelID, GPUUtilizationPercent: entry.GPUUtilization,
		GPUVRAMBytes: selected, ArtifactBytes: entry.DownloadBytes, MaxContextTokens: maximum,
	}, true
}
