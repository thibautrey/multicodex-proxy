package runtimeprofile

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
)

const (
	LegacyVersionV2      = "provider-runtime-workload-profile-v2"
	maximumCatalogBytes  = 1 << 20
	maximumOverrideBytes = 64 << 10
)

type MigrationDefaults struct {
	BaseProfileID           string
	ModelFormat             string
	Quantization            string
	License                 string
	HardwareClass           string
	AdapterVersion          string
	RecommendationSourceURL string
	RecommendationDigest    string
	RecommendationLicense   string
	BatchSize               uint32
	Parallelism             uint32
	GPUOffloadLayers        uint32
	ReserveMemoryBytes      uint64
}

type legacyV2Profile struct {
	SchemaVersion string              `json:"schema_version"`
	Model         legacyV2Model       `json:"model"`
	Accelerator   legacyV2Accelerator `json:"accelerator"`
	Runtime       legacyV2Runtime     `json:"runtime"`
}

type legacyV2Model struct {
	ModelID              string   `json:"model_id"`
	CompatibleBackendIDs []string `json:"compatible_backend_ids"`
	ContentDigest        string   `json:"content_digest"`
	AssessmentDigest     string   `json:"assessment_digest"`
	RequiredContext      uint64   `json:"required_context_tokens"`
	EstimatedVRAMBytes   uint64   `json:"estimated_vram_bytes"`
	DownloadBytes        uint64   `json:"download_bytes"`
}

type legacyV2Accelerator struct {
	Profile      string `json:"profile"`
	OS           string `json:"os"`
	Architecture string `json:"architecture"`
	Kind         string `json:"kind"`
	MemoryBytes  uint64 `json:"memory_bytes"`
}

type legacyV2Requirements struct {
	Execute bool `json:"execute"`
	Stream  bool `json:"stream"`
	Cancel  bool `json:"cancel"`
	Cleanup bool `json:"cleanup"`
}

type legacyV2Provenance struct {
	BackendID       string            `json:"backend_id"`
	SourceURL       string            `json:"source_url"`
	Version         string            `json:"version"`
	ArtifactSHA256  map[string]string `json:"artifact_sha256"`
	ContainerImages []string          `json:"container_images"`
}

type legacyV2Runtime struct {
	ContractVersion      string               `json:"contract_version"`
	RequiredCapabilities legacyV2Requirements `json:"required_capabilities"`
	Provenance           []legacyV2Provenance `json:"provenance"`
}

func Load(path string, defaults MigrationDefaults) (Catalog, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return Catalog{}, ErrInvalidCatalog
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() < 1 || info.Size() > maximumCatalogBytes {
		return Catalog{}, ErrInvalidCatalog
	}
	file, err := os.Open(path)
	if err != nil {
		return Catalog{}, wrapInvalid(err)
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil || !os.SameFile(info, openedInfo) || !openedInfo.Mode().IsRegular() {
		return Catalog{}, ErrInvalidCatalog
	}
	raw, err := io.ReadAll(io.LimitReader(file, maximumCatalogBytes+1))
	if err != nil || len(raw) > maximumCatalogBytes {
		return Catalog{}, ErrInvalidCatalog
	}
	return Decode(raw, defaults)
}

func LoadOverrides(path string) (LocalOverrides, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return LocalOverrides{}, ErrInvalidSelection
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() < 1 || info.Size() > maximumOverrideBytes {
		return LocalOverrides{}, ErrInvalidSelection
	}
	file, err := os.Open(path)
	if err != nil {
		return LocalOverrides{}, ErrInvalidSelection
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	if err != nil || !os.SameFile(info, openedInfo) || !openedInfo.Mode().IsRegular() {
		return LocalOverrides{}, ErrInvalidSelection
	}
	raw, err := io.ReadAll(io.LimitReader(file, maximumOverrideBytes+1))
	if err != nil || len(raw) > maximumOverrideBytes {
		return LocalOverrides{}, ErrInvalidSelection
	}
	return DecodeOverrides(raw)
}

func DecodeOverrides(raw []byte) (LocalOverrides, error) {
	if len(raw) < 2 || len(raw) > maximumOverrideBytes || validateUniqueJSONKeys(raw) != nil {
		return LocalOverrides{}, ErrInvalidSelection
	}
	var overrides LocalOverrides
	if strictDecode(raw, &overrides) != nil || validateOverrides(overrides, 0) != nil {
		return LocalOverrides{}, ErrInvalidSelection
	}
	return overrides, nil
}

// Decode dual-reads the current catalog and the legacy single-workload v2
// format. A v2 artifact is accepted only with explicit reviewed migration
// defaults; no model format, quantization, licensing or tuning is guessed.
func Decode(raw []byte, defaults MigrationDefaults) (Catalog, error) {
	if len(raw) < 2 || len(raw) > maximumCatalogBytes || validateUniqueJSONKeys(raw) != nil {
		return Catalog{}, ErrInvalidCatalog
	}
	var header struct {
		SchemaVersion string `json:"schema_version"`
	}
	if json.Unmarshal(raw, &header) != nil {
		return Catalog{}, ErrInvalidCatalog
	}
	switch header.SchemaVersion {
	case CatalogVersionV3:
		var catalog Catalog
		if strictDecode(raw, &catalog) != nil || Validate(catalog) != nil {
			return Catalog{}, ErrInvalidCatalog
		}
		return catalog, nil
	case LegacyVersionV2:
		var legacy legacyV2Profile
		if strictDecode(raw, &legacy) != nil {
			return Catalog{}, ErrInvalidCatalog
		}
		return migrateV2(raw, legacy, defaults)
	default:
		return Catalog{}, ErrInvalidCatalog
	}
}

func migrateV2(raw []byte, legacy legacyV2Profile, defaults MigrationDefaults) (Catalog, error) {
	if validateLegacyV2(legacy) != nil || validateMigrationDefaults(defaults) != nil {
		return Catalog{}, ErrInvalidCatalog
	}
	provenanceByID := make(map[string]legacyV2Provenance, len(legacy.Runtime.Provenance))
	for _, provenance := range legacy.Runtime.Provenance {
		provenanceByID[provenance.BackendID] = provenance
	}
	profiles := make([]Profile, 0, len(legacy.Model.CompatibleBackendIDs))
	for index, backendID := range legacy.Model.CompatibleBackendIDs {
		provenance, exists := provenanceByID[backendID]
		if !exists {
			return Catalog{}, ErrInvalidCatalog
		}
		artifactDigest, err := legacyRuntimeDigest(provenance)
		if err != nil {
			return Catalog{}, ErrInvalidCatalog
		}
		profiles = append(profiles, Profile{
			SchemaVersion: ProfileVersionV3,
			ID:            defaults.BaseProfileID + "-" + backendID,
			Priority:      uint16(index + 1),
			Model: Model{
				ID:                     legacy.Model.ModelID,
				ContentDigest:          legacy.Model.ContentDigest,
				Format:                 defaults.ModelFormat,
				Quantization:           defaults.Quantization,
				ArtifactBytes:          legacy.Model.DownloadBytes,
				License:                defaults.License,
				HostedInferenceAllowed: true,
				LicenseAssessment:      normalizeLegacyDigest(legacy.Model.AssessmentDigest),
			},
			Hardware: Hardware{
				Class:                         defaults.HardwareClass,
				OS:                            legacy.Accelerator.OS,
				Architecture:                  legacy.Accelerator.Architecture,
				AcceleratorKind:               legacy.Accelerator.Kind,
				MinimumAcceleratorMemoryBytes: legacy.Accelerator.MemoryBytes,
			},
			Runtime: Runtime{
				BackendID:             backendID,
				ContractVersion:       legacy.Runtime.ContractVersion,
				AdapterVersion:        defaults.AdapterVersion,
				RuntimeArtifactDigest: artifactDigest,
			},
			Tuning: Tuning{
				ContextTokens:        legacy.Model.RequiredContext,
				BatchSize:            defaults.BatchSize,
				Parallelism:          defaults.Parallelism,
				GPUOffloadLayers:     defaults.GPUOffloadLayers,
				EstimatedMemoryBytes: legacy.Model.EstimatedVRAMBytes,
				ReserveMemoryBytes:   defaults.ReserveMemoryBytes,
			},
			Provenance: ProfileProvenance{
				RecommendationSourceURL: defaults.RecommendationSourceURL,
				RecommendationDigest:    defaults.RecommendationDigest,
				Method:                  "migrated-reviewed-v2",
				License:                 defaults.RecommendationLicense,
			},
		})
	}
	sort.Slice(profiles, func(left, right int) bool { return profiles[left].ID < profiles[right].ID })
	catalog := Catalog{
		SchemaVersion: CatalogVersionV3,
		Format:        CatalogFormat,
		License:       defaults.RecommendationLicense,
		Provenance: CatalogProvenance{
			SourceURL:    defaults.RecommendationSourceURL,
			SourceDigest: sha256Digest(raw),
			MigratedFrom: LegacyVersionV2,
		},
		Profiles: profiles,
	}
	return Finalize(catalog)
}

func validateLegacyV2(legacy legacyV2Profile) error {
	if legacy.SchemaVersion != LegacyVersionV2 || !validModelID(legacy.Model.ModelID) ||
		!digestPattern.MatchString(legacy.Model.ContentDigest) || normalizeLegacyDigest(legacy.Model.AssessmentDigest) == "" ||
		legacy.Model.RequiredContext == 0 || legacy.Model.RequiredContext > maximumContextTokens ||
		legacy.Model.EstimatedVRAMBytes == 0 || legacy.Model.EstimatedVRAMBytes > maximumMemoryBytes ||
		legacy.Model.DownloadBytes == 0 || legacy.Model.DownloadBytes > maximumMemoryBytes ||
		len(legacy.Model.CompatibleBackendIDs) == 0 || len(legacy.Model.CompatibleBackendIDs) > 32 ||
		!sortedUniqueSlugs(legacy.Model.CompatibleBackendIDs) || !slugPattern.MatchString(legacy.Accelerator.Profile) ||
		!slugPattern.MatchString(legacy.Accelerator.OS) || !slugPattern.MatchString(legacy.Accelerator.Architecture) ||
		!slugPattern.MatchString(legacy.Accelerator.Kind) || legacy.Accelerator.MemoryBytes == 0 ||
		legacy.Accelerator.MemoryBytes > maximumMemoryBytes || !profilePattern.MatchString(legacy.Runtime.ContractVersion) ||
		!legacy.Runtime.RequiredCapabilities.Execute || len(legacy.Runtime.Provenance) != len(legacy.Model.CompatibleBackendIDs) {
		return ErrInvalidCatalog
	}
	previous := ""
	for _, provenance := range legacy.Runtime.Provenance {
		if provenance.BackendID <= previous || !slugPattern.MatchString(provenance.BackendID) || !validHTTPSURL(provenance.SourceURL) ||
			!profilePattern.MatchString(provenance.Version) || len(provenance.ArtifactSHA256) == 0 || len(provenance.ArtifactSHA256) > 16 ||
			len(provenance.ContainerImages) > 16 {
			return ErrInvalidCatalog
		}
		for platform, digest := range provenance.ArtifactSHA256 {
			if !slugPattern.MatchString(platform) || normalizeLegacyDigest(digest) == "" {
				return ErrInvalidCatalog
			}
		}
		for _, image := range provenance.ContainerImages {
			if len(image) < 72 || len(image) > 384 || !containsDigestPin(image) {
				return ErrInvalidCatalog
			}
		}
		previous = provenance.BackendID
	}
	return nil
}

func validateMigrationDefaults(defaults MigrationDefaults) error {
	combinedID := defaults.BaseProfileID + "-x"
	if !profilePattern.MatchString(combinedID) || !slugPattern.MatchString(defaults.ModelFormat) ||
		!slugPattern.MatchString(defaults.Quantization) || !licensePattern.MatchString(defaults.License) ||
		!slugPattern.MatchString(defaults.HardwareClass) || !profilePattern.MatchString(defaults.AdapterVersion) ||
		!validHTTPSURL(defaults.RecommendationSourceURL) || !digestPattern.MatchString(defaults.RecommendationDigest) ||
		!licensePattern.MatchString(defaults.RecommendationLicense) || defaults.BatchSize == 0 ||
		defaults.BatchSize > maximumBatchSize || defaults.Parallelism == 0 || defaults.Parallelism > maximumParallelism ||
		defaults.GPUOffloadLayers > maximumGPUOffloadLayers || defaults.ReserveMemoryBytes == 0 ||
		defaults.ReserveMemoryBytes > maximumMemoryBytes {
		return ErrInvalidCatalog
	}
	return nil
}

func legacyRuntimeDigest(provenance legacyV2Provenance) (string, error) {
	raw, err := json.Marshal(provenance)
	if err != nil {
		return "", err
	}
	return sha256Digest(raw), nil
}

func normalizeLegacyDigest(value string) string {
	if digestPattern.MatchString(value) {
		return value
	}
	if len(value) != 64 {
		return ""
	}
	if _, err := hex.DecodeString(value); err != nil || value != string(bytes.ToLower([]byte(value))) {
		return ""
	}
	return "sha256:" + value
}

func containsDigestPin(value string) bool {
	index := bytes.LastIndex([]byte(value), []byte("@sha256:"))
	return index > 0 && digestPattern.MatchString(value[index+1:])
}

func strictDecode(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return ErrInvalidCatalog
	}
	return nil
}

func validateUniqueJSONKeys(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := consumeJSONValue(decoder); err != nil {
		return err
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return ErrInvalidCatalog
	}
	return nil
}

func consumeJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, isDelimiter := token.(json.Delim)
	if !isDelimiter {
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
				return ErrInvalidCatalog
			}
			if _, duplicate := seen[key]; duplicate {
				return ErrInvalidCatalog
			}
			seen[key] = struct{}{}
			if err := consumeJSONValue(decoder); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return ErrInvalidCatalog
		}
	case '[':
		for decoder.More() {
			if err := consumeJSONValue(decoder); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim(']') {
			return ErrInvalidCatalog
		}
	default:
		return ErrInvalidCatalog
	}
	return nil
}
