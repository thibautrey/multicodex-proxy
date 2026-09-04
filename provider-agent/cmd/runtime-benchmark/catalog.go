package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/thibautrey/multivibe/provider-agent/runtimebenchmark"
	"github.com/thibautrey/multivibe/provider-agent/runtimeprofile"
)

const (
	benchmarkModelCatalogVersion = "provider-model-catalog-v1"
	benchmarkOllamaVersion       = "0.33.2"
	benchmarkRuntimeBackend      = "ollama-managed"
	benchmarkRuntimeContract     = "provider-runtime-backend-v1"
	benchmarkRuntimeAdapter      = "ollama-adapter-v1"
	maximumBenchmarkCatalogBytes = 1 << 20
	maximumBenchmarkCatalogItems = 512
	maximumBenchmarkArtifactSize = uint64(1 << 50)
)

func supportsBenchmarkProfile(profile runtimeprofile.Profile) bool {
	return profile.Runtime.BackendID == benchmarkRuntimeBackend &&
		profile.Runtime.ContractVersion == benchmarkRuntimeContract &&
		profile.Runtime.AdapterVersion == benchmarkRuntimeAdapter &&
		profile.Tuning.Parallelism == 1 && profile.Tuning.GPUOffloadLayers > 0
}

func supportsBenchmarkPlatform(profile runtimeprofile.Profile, operatingSystem, architecture string) bool {
	return profile.Hardware.OS == operatingSystem && profile.Hardware.Architecture == architecture
}

var (
	benchmarkCanonicalModelPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}:[a-z0-9][a-z0-9._-]{0,63}/[a-z0-9][a-z0-9._-]{0,127}(/[a-z0-9][a-z0-9._-]{0,127})*$`)
	benchmarkOllamaModelPattern    = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,63}$`)
	benchmarkDigestPattern         = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	benchmarkRawDigestPattern      = regexp.MustCompile(`^[a-f0-9]{64}$`)
	benchmarkLicensePattern        = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$`)
	benchmarkVersionPattern        = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)
)

type benchmarkModelCatalogLicense struct {
	LicenseID              string `json:"license_id"`
	HostedInferenceAllowed bool   `json:"hosted_inference_allowed"`
	AssessmentPath         string `json:"assessment_path"`
	AssessmentDigest       string `json:"assessment_digest"`
}

type benchmarkModelCatalogVRAM struct {
	ContextTokens         uint64 `json:"context_tokens"`
	EstimatedVRAMBytesHex string `json:"estimated_vram_bytes_hex"`
}

type benchmarkModelCatalogEntry struct {
	CanonicalModelID   string                       `json:"canonical_model_id"`
	OllamaModel        string                       `json:"ollama_model"`
	OllamaManifestPath string                       `json:"ollama_manifest_path"`
	ContentDigest      string                       `json:"content_digest"`
	DownloadBytesHex   string                       `json:"download_bytes_hex"`
	GPUUtilization     uint8                        `json:"gpu_utilization_percent"`
	VRAMEstimates      []benchmarkModelCatalogVRAM  `json:"vram_estimates"`
	License            benchmarkModelCatalogLicense `json:"license"`
	downloadBytes      uint64
}

type benchmarkModelCatalog struct {
	SchemaVersion string                       `json:"schema_version"`
	Models        []benchmarkModelCatalogEntry `json:"models"`
	fileDigest    string
}

type benchmarkDependencyArtifact struct {
	URL     string `json:"url"`
	SHA256  string `json:"sha256"`
	Archive string `json:"archive"`
}

type benchmarkDependency struct {
	Version   string                                 `json:"version"`
	Artifacts map[string]benchmarkDependencyArtifact `json:"artifacts"`
}

type benchmarkHostDependencies struct {
	SchemaVersion uint64              `json:"schemaVersion"`
	Node          benchmarkDependency `json:"node"`
	Ollama        benchmarkDependency `json:"ollama"`
}

func loadBenchmarkModelCatalog(path string) (benchmarkModelCatalog, error) {
	var catalog benchmarkModelCatalog
	raw, err := decodeBenchmarkJSONFile(path, &catalog)
	if err != nil || validateBenchmarkModelCatalog(&catalog) != nil {
		return benchmarkModelCatalog{}, runtimebenchmark.ErrInvalid
	}
	digest := sha256.Sum256(raw)
	catalog.fileDigest = "sha256:" + hex.EncodeToString(digest[:])
	return catalog, nil
}

func validateBenchmarkModelCatalog(catalog *benchmarkModelCatalog) error {
	if catalog == nil || catalog.SchemaVersion != benchmarkModelCatalogVersion || len(catalog.Models) < 1 ||
		len(catalog.Models) > maximumBenchmarkCatalogItems {
		return runtimebenchmark.ErrInvalid
	}
	previousModelID := ""
	ollamaModels := make(map[string]struct{}, len(catalog.Models))
	manifestPaths := make(map[string]struct{}, len(catalog.Models))
	for index := range catalog.Models {
		model := &catalog.Models[index]
		downloadBytes, err := parseBenchmarkHexBytes(model.DownloadBytesHex)
		if err != nil || downloadBytes == 0 || downloadBytes > maximumBenchmarkArtifactSize ||
			!benchmarkCanonicalModelPattern.MatchString(model.CanonicalModelID) || model.CanonicalModelID <= previousModelID ||
			!benchmarkOllamaModelPattern.MatchString(model.OllamaModel) || !safeBenchmarkRelativePath(model.OllamaManifestPath, "") ||
			!benchmarkDigestPattern.MatchString(model.ContentDigest) || model.GPUUtilization < 1 || model.GPUUtilization > 100 ||
			len(model.VRAMEstimates) < 1 || len(model.VRAMEstimates) > 16 ||
			!benchmarkLicensePattern.MatchString(model.License.LicenseID) || !model.License.HostedInferenceAllowed ||
			!safeBenchmarkRelativePath(model.License.AssessmentPath, "provider-model-license-assessments/") ||
			filepath.Ext(model.License.AssessmentPath) != ".md" || !benchmarkRawDigestPattern.MatchString(model.License.AssessmentDigest) {
			return runtimebenchmark.ErrInvalid
		}
		if _, exists := ollamaModels[model.OllamaModel]; exists {
			return runtimebenchmark.ErrInvalid
		}
		if _, exists := manifestPaths[model.OllamaManifestPath]; exists {
			return runtimebenchmark.ErrInvalid
		}
		ollamaModels[model.OllamaModel] = struct{}{}
		manifestPaths[model.OllamaManifestPath] = struct{}{}
		previousModelID = model.CanonicalModelID
		model.downloadBytes = downloadBytes
		previousContext := uint64(0)
		for _, estimate := range model.VRAMEstimates {
			estimatedBytes, err := parseBenchmarkHexBytes(estimate.EstimatedVRAMBytesHex)
			if err != nil || estimate.ContextTokens == 0 || estimate.ContextTokens > 1<<20 || estimate.ContextTokens <= previousContext ||
				estimatedBytes == 0 || estimatedBytes > maximumBenchmarkArtifactSize {
				return runtimebenchmark.ErrInvalid
			}
			previousContext = estimate.ContextTokens
		}
	}
	return nil
}

func (catalog benchmarkModelCatalog) entry(modelID string) (benchmarkModelCatalogEntry, bool) {
	index := sort.Search(len(catalog.Models), func(index int) bool {
		return catalog.Models[index].CanonicalModelID >= modelID
	})
	if index >= len(catalog.Models) || catalog.Models[index].CanonicalModelID != modelID {
		return benchmarkModelCatalogEntry{}, false
	}
	return catalog.Models[index], true
}

func (catalog benchmarkModelCatalog) modelForProfile(runtimeCatalog runtimeprofile.Catalog, profile runtimeprofile.Profile) (benchmarkModelCatalogEntry, error) {
	entry, found := catalog.entry(profile.Model.ID)
	if !found || catalog.fileDigest != runtimeCatalog.Provenance.SourceDigest ||
		catalog.fileDigest != profile.Provenance.RecommendationDigest ||
		entry.CanonicalModelID != profile.Model.ID || entry.ContentDigest != profile.Model.ContentDigest ||
		entry.downloadBytes != profile.Model.ArtifactBytes || entry.License.LicenseID != profile.Model.License ||
		entry.License.HostedInferenceAllowed != profile.Model.HostedInferenceAllowed ||
		"sha256:"+entry.License.AssessmentDigest != profile.Model.LicenseAssessment {
		return benchmarkModelCatalogEntry{}, runtimeprofile.ErrNoCompatible
	}
	return entry, nil
}

func loadBenchmarkOllamaExpectation(runtimeCatalogPath string, profile runtimeprofile.Profile) (string, error) {
	dependenciesPath := filepath.Join(filepath.Dir(runtimeCatalogPath), "provider-host-dependencies.json")
	var dependencies benchmarkHostDependencies
	if _, err := decodeBenchmarkJSONFile(dependenciesPath, &dependencies); err != nil ||
		validateBenchmarkHostDependencies(&dependencies) != nil || dependencies.Ollama.Version != benchmarkOllamaVersion {
		return "", runtimebenchmark.ErrInvalid
	}
	platform := profile.Hardware.OS + "-" + profile.Hardware.Architecture
	artifact, found := dependencies.Ollama.Artifacts[platform]
	if !found || "sha256:"+artifact.SHA256 != profile.Runtime.RuntimeArtifactDigest {
		return "", runtimeprofile.ErrNoCompatible
	}
	return dependencies.Ollama.Version, nil
}

func validateBenchmarkHostDependencies(dependencies *benchmarkHostDependencies) error {
	if dependencies == nil || dependencies.SchemaVersion != 1 || validateBenchmarkDependency(dependencies.Node) != nil ||
		validateBenchmarkDependency(dependencies.Ollama) != nil {
		return runtimebenchmark.ErrInvalid
	}
	return nil
}

func validateBenchmarkDependency(dependency benchmarkDependency) error {
	if !benchmarkVersionPattern.MatchString(dependency.Version) || len(dependency.Artifacts) < 1 || len(dependency.Artifacts) > 8 {
		return runtimebenchmark.ErrInvalid
	}
	for platform, artifact := range dependency.Artifacts {
		if (platform != "darwin-arm64" && platform != "darwin-amd64" && platform != "linux-amd64" && platform != "windows-amd64") || !benchmarkRawDigestPattern.MatchString(artifact.SHA256) ||
			(artifact.Archive != "tar-gzip" && artifact.Archive != "tar-zstd" && artifact.Archive != "zip") || !safeBenchmarkHTTPSURL(artifact.URL) {
			return runtimebenchmark.ErrInvalid
		}
	}
	return nil
}

func decodeBenchmarkJSONFile(path string, destination any) ([]byte, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || destination == nil {
		return nil, runtimebenchmark.ErrInvalid
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() < 2 || info.Size() > maximumBenchmarkCatalogBytes {
		return nil, runtimebenchmark.ErrInvalid
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, runtimebenchmark.ErrInvalid
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil || !openedInfo.Mode().IsRegular() || !os.SameFile(info, openedInfo) {
		return nil, runtimebenchmark.ErrInvalid
	}
	raw, err := io.ReadAll(io.LimitReader(file, maximumBenchmarkCatalogBytes+1))
	if err != nil || len(raw) > maximumBenchmarkCatalogBytes || validateBenchmarkUniqueJSONKeys(raw) != nil {
		return nil, runtimebenchmark.ErrInvalid
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return nil, runtimebenchmark.ErrInvalid
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return nil, runtimebenchmark.ErrInvalid
	}
	return raw, nil
}

func validateBenchmarkUniqueJSONKeys(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := consumeBenchmarkJSONValue(decoder); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return runtimebenchmark.ErrInvalid
	}
	return nil
}

func consumeBenchmarkJSONValue(decoder *json.Decoder) error {
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
				return runtimebenchmark.ErrInvalid
			}
			if _, duplicate := seen[key]; duplicate {
				return runtimebenchmark.ErrInvalid
			}
			seen[key] = struct{}{}
			if err := consumeBenchmarkJSONValue(decoder); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return runtimebenchmark.ErrInvalid
		}
	case '[':
		for decoder.More() {
			if err := consumeBenchmarkJSONValue(decoder); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim(']') {
			return runtimebenchmark.ErrInvalid
		}
	default:
		return runtimebenchmark.ErrInvalid
	}
	return nil
}

func parseBenchmarkHexBytes(value string) (uint64, error) {
	if len(value) < 3 || len(value) > 18 || !strings.HasPrefix(value, "0x") {
		return 0, runtimebenchmark.ErrInvalid
	}
	return strconv.ParseUint(value[2:], 16, 64)
}

func safeBenchmarkRelativePath(value, requiredPrefix string) bool {
	if value == "" || len(value) > 256 || filepath.IsAbs(value) || filepath.Clean(value) != value ||
		strings.Contains(value, "\\") || (requiredPrefix != "" && !strings.HasPrefix(value, requiredPrefix)) {
		return false
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
		for _, character := range segment {
			if character < 0x21 || character > 0x7e {
				return false
			}
		}
	}
	return true
}

func safeBenchmarkHTTPSURL(value string) bool {
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil && parsed.Fragment == ""
}
