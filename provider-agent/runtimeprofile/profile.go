// Package runtimeprofile validates and selects declarative, reviewable model
// runtime profiles. It deliberately does not discover hardware, start a
// runtime, or trust capabilities advertised over the network.
package runtimeprofile

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"net/url"
	"regexp"
	"sort"
	"strings"
)

const (
	CatalogVersionV3        = "provider-runtime-profile-catalog-v3"
	ProfileVersionV3        = "provider-runtime-profile-v3"
	OverrideVersionV1       = "provider-runtime-profile-overrides-v1"
	BenchmarkResultVersion  = "provider-runtime-benchmark-result-v1"
	CatalogFormat           = "multivibe-runtime-profile-catalog"
	maximumProfiles         = 512
	maximumMemoryBytes      = uint64(1 << 50)
	maximumContextTokens    = uint64(1 << 20)
	maximumBatchSize        = uint32(4096)
	maximumParallelism      = uint32(256)
	maximumGPUOffloadLayers = uint32(4096)
)

var (
	ErrInvalidCatalog   = errors.New("runtime profile catalog is invalid")
	ErrInvalidSelection = errors.New("runtime profile selection is invalid")
	ErrNoCompatible     = errors.New("no compatible runtime profile is available")

	slugPattern    = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)
	profilePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,127}$`)
	modelPattern   = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}:[a-z0-9][a-z0-9._-]{0,63}/[a-z0-9][a-z0-9._-]{0,127}(/[a-z0-9][a-z0-9._-]{0,127})*$`)
	digestPattern  = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	licensePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$`)
)

type Catalog struct {
	SchemaVersion string            `json:"schema_version"`
	Format        string            `json:"format"`
	CatalogDigest string            `json:"catalog_digest"`
	License       string            `json:"license"`
	Provenance    CatalogProvenance `json:"provenance"`
	Profiles      []Profile         `json:"profiles"`
}

type CatalogProvenance struct {
	SourceURL    string `json:"source_url"`
	SourceDigest string `json:"source_digest"`
	MigratedFrom string `json:"migrated_from,omitempty"`
}

type Profile struct {
	SchemaVersion string            `json:"schema_version"`
	ID            string            `json:"id"`
	ProfileDigest string            `json:"profile_digest"`
	Priority      uint16            `json:"priority"`
	Model         Model             `json:"model"`
	Hardware      Hardware          `json:"hardware"`
	Runtime       Runtime           `json:"runtime"`
	Tuning        Tuning            `json:"tuning"`
	Provenance    ProfileProvenance `json:"provenance"`
}

type Model struct {
	ID                     string `json:"id"`
	ContentDigest          string `json:"content_digest"`
	Format                 string `json:"format"`
	Quantization           string `json:"quantization"`
	ArtifactBytes          uint64 `json:"artifact_bytes"`
	License                string `json:"license"`
	HostedInferenceAllowed bool   `json:"hosted_inference_allowed"`
	LicenseAssessment      string `json:"license_assessment_digest"`
}

type Hardware struct {
	Class                         string `json:"class"`
	OS                            string `json:"os"`
	Architecture                  string `json:"architecture"`
	AcceleratorKind               string `json:"accelerator_kind"`
	MinimumAcceleratorMemoryBytes uint64 `json:"minimum_accelerator_memory_bytes"`
	UnifiedMemory                 bool   `json:"unified_memory"`
}

type Runtime struct {
	BackendID             string `json:"backend_id"`
	ContractVersion       string `json:"contract_version"`
	AdapterVersion        string `json:"adapter_version"`
	RuntimeArtifactDigest string `json:"runtime_artifact_digest"`
}

type Tuning struct {
	ContextTokens        uint64 `json:"context_tokens"`
	BatchSize            uint32 `json:"batch_size"`
	Parallelism          uint32 `json:"parallelism"`
	GPUOffloadLayers     uint32 `json:"gpu_offload_layers"`
	EstimatedMemoryBytes uint64 `json:"estimated_memory_bytes"`
	ReserveMemoryBytes   uint64 `json:"reserve_memory_bytes"`
}

type ProfileProvenance struct {
	RecommendationSourceURL string `json:"recommendation_source_url"`
	RecommendationDigest    string `json:"recommendation_digest"`
	Method                  string `json:"method"`
	License                 string `json:"license"`
}

// RuntimeCapability is local, already-attested capability data. Callers must
// not populate it directly from an untrusted runtime response.
type RuntimeCapability struct {
	BackendID             string
	ContractVersion       string
	Available             bool
	Formats               []string
	Quantizations         []string
	HardwareClasses       []string
	MaximumContextTokens  uint64
	MaximumBatchSize      uint32
	MaximumParallelism    uint32
	MaximumMemoryBytes    uint64
	SupportsGPUOffload    bool
	RuntimeArtifactDigest string
}

type SelectionRequest struct {
	ModelID               string
	ContentDigest         string
	Format                string
	Quantization          string
	RequiredContextTokens uint64
	Hardware              Hardware
	AvailableMemoryBytes  uint64
	Runtimes              []RuntimeCapability
	Benchmarks            []ValidatedBenchmark
	Overrides             *LocalOverrides
}

// ValidatedBenchmark is accepted only when all catalog/profile digests match.
// Signature and local-machine provenance validation remains the caller's trust
// boundary; this package never treats an arbitrary benchmark file as trusted.
type ValidatedBenchmark struct {
	SchemaVersion                string
	CatalogDigest                string
	ProfileID                    string
	ProfileDigest                string
	ProfileCompatibilityAttested bool
	Passed                       bool
	StabilityBasisPoints         uint16
	TokensPerSecondMilliP50      uint64
	ObservedBaselineMemoryBytes  uint64
	ObservedPeakMemoryBytes      uint64
	ObservedRecoveryMemoryBytes  uint64
}

type LocalOverrides struct {
	SchemaVersion      string  `json:"schema_version"`
	RequireProfileID   string  `json:"require_profile_id,omitempty"`
	RequireBackendID   string  `json:"require_backend_id,omitempty"`
	ContextTokens      *uint64 `json:"context_tokens,omitempty"`
	BatchSize          *uint32 `json:"batch_size,omitempty"`
	Parallelism        *uint32 `json:"parallelism,omitempty"`
	GPUOffloadLayers   *uint32 `json:"gpu_offload_layers,omitempty"`
	MaximumMemoryBytes *uint64 `json:"maximum_memory_bytes,omitempty"`
}

type EffectiveProfile struct {
	Profile           Profile `json:"profile"`
	Tuning            Tuning  `json:"tuning"`
	MemoryBudgetBytes uint64  `json:"memory_budget_bytes"`
}

type SelectionExplanation struct {
	SelectedProfileID  string   `json:"selected_profile_id"`
	SelectedBackendID  string   `json:"selected_backend_id"`
	Basis              string   `json:"basis"`
	Forced             bool     `json:"forced"`
	CompatibleProfiles []string `json:"compatible_profiles"`
}

type Selection struct {
	Effective   EffectiveProfile     `json:"effective"`
	Explanation SelectionExplanation `json:"explanation"`
}

func ProfileDigest(profile Profile) (string, error) {
	profile.ProfileDigest = ""
	raw, err := json.Marshal(profile)
	if err != nil {
		return "", err
	}
	return sha256Digest(raw), nil
}

func CatalogDigest(catalog Catalog) (string, error) {
	type digestProfile struct {
		ID     string `json:"id"`
		Digest string `json:"digest"`
	}
	type material struct {
		SchemaVersion string            `json:"schema_version"`
		Format        string            `json:"format"`
		License       string            `json:"license"`
		Provenance    CatalogProvenance `json:"provenance"`
		Profiles      []digestProfile   `json:"profiles"`
	}
	profiles := make([]digestProfile, len(catalog.Profiles))
	for index, profile := range catalog.Profiles {
		profiles[index] = digestProfile{ID: profile.ID, Digest: profile.ProfileDigest}
	}
	raw, err := json.Marshal(material{
		SchemaVersion: catalog.SchemaVersion,
		Format:        catalog.Format,
		License:       catalog.License,
		Provenance:    catalog.Provenance,
		Profiles:      profiles,
	})
	if err != nil {
		return "", err
	}
	return sha256Digest(raw), nil
}

func Finalize(catalog Catalog) (Catalog, error) {
	for index := range catalog.Profiles {
		digest, err := ProfileDigest(catalog.Profiles[index])
		if err != nil {
			return Catalog{}, err
		}
		catalog.Profiles[index].ProfileDigest = digest
	}
	digest, err := CatalogDigest(catalog)
	if err != nil {
		return Catalog{}, err
	}
	catalog.CatalogDigest = digest
	if err := Validate(catalog); err != nil {
		return Catalog{}, err
	}
	return catalog, nil
}

func Validate(catalog Catalog) error {
	if catalog.SchemaVersion != CatalogVersionV3 || catalog.Format != CatalogFormat ||
		!licensePattern.MatchString(catalog.License) || !validHTTPSURL(catalog.Provenance.SourceURL) ||
		!digestPattern.MatchString(catalog.Provenance.SourceDigest) ||
		(catalog.Provenance.MigratedFrom != "" && catalog.Provenance.MigratedFrom != LegacyVersionV2) ||
		len(catalog.Profiles) < 1 || len(catalog.Profiles) > maximumProfiles || !digestPattern.MatchString(catalog.CatalogDigest) {
		return ErrInvalidCatalog
	}
	previous := ""
	for _, profile := range catalog.Profiles {
		if profile.ID <= previous || validateProfile(profile) != nil {
			return ErrInvalidCatalog
		}
		digest, err := ProfileDigest(profile)
		if err != nil || digest != profile.ProfileDigest {
			return ErrInvalidCatalog
		}
		previous = profile.ID
	}
	digest, err := CatalogDigest(catalog)
	if err != nil || digest != catalog.CatalogDigest {
		return ErrInvalidCatalog
	}
	return nil
}

func validateProfile(profile Profile) error {
	combinedMemory, overflow := checkedAdd(profile.Tuning.EstimatedMemoryBytes, profile.Tuning.ReserveMemoryBytes)
	if profile.SchemaVersion != ProfileVersionV3 || !profilePattern.MatchString(profile.ID) ||
		!digestPattern.MatchString(profile.ProfileDigest) || profile.Priority == 0 ||
		!validModelID(profile.Model.ID) || !digestPattern.MatchString(profile.Model.ContentDigest) ||
		!slugPattern.MatchString(profile.Model.Format) || !slugPattern.MatchString(profile.Model.Quantization) ||
		profile.Model.ArtifactBytes == 0 || profile.Model.ArtifactBytes > maximumMemoryBytes ||
		!licensePattern.MatchString(profile.Model.License) || !profile.Model.HostedInferenceAllowed ||
		!digestPattern.MatchString(profile.Model.LicenseAssessment) ||
		!slugPattern.MatchString(profile.Hardware.Class) || !slugPattern.MatchString(profile.Hardware.OS) ||
		!slugPattern.MatchString(profile.Hardware.Architecture) || !slugPattern.MatchString(profile.Hardware.AcceleratorKind) ||
		profile.Hardware.MinimumAcceleratorMemoryBytes == 0 || profile.Hardware.MinimumAcceleratorMemoryBytes > maximumMemoryBytes ||
		!slugPattern.MatchString(profile.Runtime.BackendID) || !profilePattern.MatchString(profile.Runtime.ContractVersion) ||
		!profilePattern.MatchString(profile.Runtime.AdapterVersion) || !digestPattern.MatchString(profile.Runtime.RuntimeArtifactDigest) ||
		profile.Tuning.ContextTokens == 0 || profile.Tuning.ContextTokens > maximumContextTokens ||
		profile.Tuning.BatchSize == 0 || profile.Tuning.BatchSize > maximumBatchSize ||
		profile.Tuning.Parallelism == 0 || profile.Tuning.Parallelism > maximumParallelism ||
		profile.Tuning.GPUOffloadLayers > maximumGPUOffloadLayers ||
		profile.Tuning.EstimatedMemoryBytes == 0 || profile.Tuning.ReserveMemoryBytes == 0 || overflow ||
		combinedMemory > profile.Hardware.MinimumAcceleratorMemoryBytes ||
		!validHTTPSURL(profile.Provenance.RecommendationSourceURL) ||
		!digestPattern.MatchString(profile.Provenance.RecommendationDigest) ||
		!slugPattern.MatchString(profile.Provenance.Method) || !licensePattern.MatchString(profile.Provenance.License) {
		return ErrInvalidCatalog
	}
	return nil
}

func Select(catalog Catalog, request SelectionRequest) (Selection, error) {
	if Validate(catalog) != nil || validateSelectionRequest(request) != nil {
		return Selection{}, ErrInvalidSelection
	}
	runtimeByID := make(map[string]RuntimeCapability, len(request.Runtimes))
	for _, capability := range request.Runtimes {
		if validateCapability(capability) != nil {
			return Selection{}, ErrInvalidSelection
		}
		if _, duplicate := runtimeByID[capability.BackendID]; duplicate {
			return Selection{}, ErrInvalidSelection
		}
		runtimeByID[capability.BackendID] = capability
	}
	benchmarkByProfile, err := validateBenchmarks(catalog, request.Benchmarks)
	if err != nil {
		return Selection{}, err
	}
	candidates := make([]Profile, 0)
	for _, profile := range catalog.Profiles {
		capability, exists := runtimeByID[profile.Runtime.BackendID]
		if !exists || !compatible(profile, capability, request) || !matchesOverride(profile, request.Overrides) {
			continue
		}
		candidates = append(candidates, profile)
	}
	if len(candidates) == 0 {
		return Selection{}, ErrNoCompatible
	}
	forced := request.Overrides != nil && (request.Overrides.RequireProfileID != "" || request.Overrides.RequireBackendID != "")
	basis := "conservative-reviewed-priority"
	for _, candidate := range candidates {
		if _, exists := benchmarkByProfile[candidate.ID]; exists {
			basis = "validated-local-benchmark"
			break
		}
	}
	sort.Slice(candidates, func(left, right int) bool {
		leftBenchmark, leftOK := benchmarkByProfile[candidates[left].ID]
		rightBenchmark, rightOK := benchmarkByProfile[candidates[right].ID]
		if leftOK != rightOK {
			return leftOK
		}
		if leftOK && leftBenchmark.TokensPerSecondMilliP50 != rightBenchmark.TokensPerSecondMilliP50 {
			return leftBenchmark.TokensPerSecondMilliP50 > rightBenchmark.TokensPerSecondMilliP50
		}
		if candidates[left].Priority != candidates[right].Priority {
			return candidates[left].Priority < candidates[right].Priority
		}
		if candidates[left].Tuning.EstimatedMemoryBytes != candidates[right].Tuning.EstimatedMemoryBytes {
			return candidates[left].Tuning.EstimatedMemoryBytes < candidates[right].Tuning.EstimatedMemoryBytes
		}
		return candidates[left].ID < candidates[right].ID
	})
	selected := candidates[0]
	effective, err := applyOverrides(selected, request)
	if err != nil {
		return Selection{}, err
	}
	compatibleIDs := make([]string, len(candidates))
	for index, candidate := range candidates {
		compatibleIDs[index] = candidate.ID
	}
	return Selection{
		Effective: effective,
		Explanation: SelectionExplanation{
			SelectedProfileID:  selected.ID,
			SelectedBackendID:  selected.Runtime.BackendID,
			Basis:              basis,
			Forced:             forced,
			CompatibleProfiles: compatibleIDs,
		},
	}, nil
}

func validateSelectionRequest(request SelectionRequest) error {
	if !validModelID(request.ModelID) || !digestPattern.MatchString(request.ContentDigest) ||
		!slugPattern.MatchString(request.Format) || !slugPattern.MatchString(request.Quantization) ||
		request.RequiredContextTokens == 0 || request.RequiredContextTokens > maximumContextTokens ||
		request.AvailableMemoryBytes == 0 || request.AvailableMemoryBytes > maximumMemoryBytes ||
		validateHardware(request.Hardware) != nil || len(request.Runtimes) == 0 || len(request.Runtimes) > 64 || len(request.Benchmarks) > maximumProfiles {
		return ErrInvalidSelection
	}
	if request.AvailableMemoryBytes < request.Hardware.MinimumAcceleratorMemoryBytes {
		return ErrInvalidSelection
	}
	if request.Overrides != nil && validateOverrides(*request.Overrides, request.RequiredContextTokens) != nil {
		return ErrInvalidSelection
	}
	return nil
}

func validateHardware(hardware Hardware) error {
	if !slugPattern.MatchString(hardware.Class) || !slugPattern.MatchString(hardware.OS) ||
		!slugPattern.MatchString(hardware.Architecture) || !slugPattern.MatchString(hardware.AcceleratorKind) ||
		hardware.MinimumAcceleratorMemoryBytes == 0 || hardware.MinimumAcceleratorMemoryBytes > maximumMemoryBytes {
		return ErrInvalidSelection
	}
	return nil
}

func validateCapability(capability RuntimeCapability) error {
	if !slugPattern.MatchString(capability.BackendID) || !profilePattern.MatchString(capability.ContractVersion) ||
		!digestPattern.MatchString(capability.RuntimeArtifactDigest) || len(capability.Formats) == 0 ||
		len(capability.Quantizations) == 0 || len(capability.HardwareClasses) == 0 ||
		!sortedUniqueSlugs(capability.Formats) || !sortedUniqueSlugs(capability.Quantizations) ||
		!sortedUniqueSlugs(capability.HardwareClasses) || capability.MaximumContextTokens == 0 ||
		capability.MaximumContextTokens > maximumContextTokens || capability.MaximumBatchSize == 0 ||
		capability.MaximumBatchSize > maximumBatchSize || capability.MaximumParallelism == 0 ||
		capability.MaximumParallelism > maximumParallelism || capability.MaximumMemoryBytes == 0 ||
		capability.MaximumMemoryBytes > maximumMemoryBytes {
		return ErrInvalidSelection
	}
	return nil
}

func validateOverrides(overrides LocalOverrides, requiredContext uint64) error {
	if overrides.SchemaVersion != OverrideVersionV1 ||
		(overrides.RequireProfileID != "" && !profilePattern.MatchString(overrides.RequireProfileID)) ||
		(overrides.RequireBackendID != "" && !slugPattern.MatchString(overrides.RequireBackendID)) ||
		(overrides.ContextTokens != nil && (*overrides.ContextTokens < requiredContext || *overrides.ContextTokens > maximumContextTokens)) ||
		(overrides.BatchSize != nil && (*overrides.BatchSize == 0 || *overrides.BatchSize > maximumBatchSize)) ||
		(overrides.Parallelism != nil && (*overrides.Parallelism == 0 || *overrides.Parallelism > maximumParallelism)) ||
		(overrides.GPUOffloadLayers != nil && *overrides.GPUOffloadLayers > maximumGPUOffloadLayers) ||
		(overrides.MaximumMemoryBytes != nil && (*overrides.MaximumMemoryBytes == 0 || *overrides.MaximumMemoryBytes > maximumMemoryBytes)) {
		return ErrInvalidSelection
	}
	return nil
}

func validateBenchmarks(catalog Catalog, benchmarks []ValidatedBenchmark) (map[string]ValidatedBenchmark, error) {
	profiles := make(map[string]Profile, len(catalog.Profiles))
	for _, profile := range catalog.Profiles {
		profiles[profile.ID] = profile
	}
	result := make(map[string]ValidatedBenchmark, len(benchmarks))
	for _, benchmark := range benchmarks {
		profile, exists := profiles[benchmark.ProfileID]
		if !exists || benchmark.SchemaVersion != BenchmarkResultVersion || benchmark.CatalogDigest != catalog.CatalogDigest ||
			benchmark.ProfileDigest != profile.ProfileDigest || !benchmark.ProfileCompatibilityAttested ||
			!benchmark.Passed || benchmark.StabilityBasisPoints < 9900 ||
			benchmark.TokensPerSecondMilliP50 == 0 || benchmark.ObservedPeakMemoryBytes == 0 ||
			benchmark.ObservedPeakMemoryBytes > profile.Hardware.MinimumAcceleratorMemoryBytes ||
			!recoveredMemory(benchmark.ObservedBaselineMemoryBytes, benchmark.ObservedRecoveryMemoryBytes) ||
			benchmark.ObservedRecoveryMemoryBytes > benchmark.ObservedPeakMemoryBytes {
			return nil, ErrInvalidSelection
		}
		if _, duplicate := result[benchmark.ProfileID]; duplicate {
			return nil, ErrInvalidSelection
		}
		result[benchmark.ProfileID] = benchmark
	}
	return result, nil
}

func compatible(profile Profile, capability RuntimeCapability, request SelectionRequest) bool {
	neededMemory, overflow := checkedAdd(profile.Tuning.EstimatedMemoryBytes, profile.Tuning.ReserveMemoryBytes)
	return !overflow && profile.Model.ID == request.ModelID && profile.Model.ContentDigest == request.ContentDigest &&
		profile.Model.Format == request.Format && profile.Model.Quantization == request.Quantization &&
		profile.Hardware == request.Hardware && profile.Tuning.ContextTokens >= request.RequiredContextTokens &&
		profile.Runtime.BackendID == capability.BackendID && profile.Runtime.ContractVersion == capability.ContractVersion &&
		profile.Runtime.RuntimeArtifactDigest == capability.RuntimeArtifactDigest && capability.Available &&
		contains(capability.Formats, profile.Model.Format) && contains(capability.Quantizations, profile.Model.Quantization) &&
		contains(capability.HardwareClasses, profile.Hardware.Class) && capability.MaximumContextTokens >= profile.Tuning.ContextTokens &&
		capability.MaximumBatchSize >= profile.Tuning.BatchSize && capability.MaximumParallelism >= profile.Tuning.Parallelism &&
		capability.MaximumMemoryBytes >= neededMemory && request.AvailableMemoryBytes >= neededMemory &&
		(profile.Tuning.GPUOffloadLayers == 0 || capability.SupportsGPUOffload)
}

func matchesOverride(profile Profile, overrides *LocalOverrides) bool {
	return overrides == nil ||
		(overrides.RequireProfileID == "" || overrides.RequireProfileID == profile.ID) &&
			(overrides.RequireBackendID == "" || overrides.RequireBackendID == profile.Runtime.BackendID)
}

func applyOverrides(profile Profile, request SelectionRequest) (EffectiveProfile, error) {
	tuning := profile.Tuning
	budget, overflow := checkedAdd(tuning.EstimatedMemoryBytes, tuning.ReserveMemoryBytes)
	if overflow {
		return EffectiveProfile{}, ErrInvalidSelection
	}
	if request.AvailableMemoryBytes < budget {
		return EffectiveProfile{}, ErrNoCompatible
	}
	if request.Overrides != nil {
		overrides := request.Overrides
		if overrides.ContextTokens != nil {
			if *overrides.ContextTokens > tuning.ContextTokens {
				return EffectiveProfile{}, ErrInvalidSelection
			}
			tuning.ContextTokens = *overrides.ContextTokens
		}
		if overrides.BatchSize != nil {
			if *overrides.BatchSize > tuning.BatchSize {
				return EffectiveProfile{}, ErrInvalidSelection
			}
			tuning.BatchSize = *overrides.BatchSize
		}
		if overrides.Parallelism != nil {
			if *overrides.Parallelism > tuning.Parallelism {
				return EffectiveProfile{}, ErrInvalidSelection
			}
			tuning.Parallelism = *overrides.Parallelism
		}
		if overrides.GPUOffloadLayers != nil {
			if *overrides.GPUOffloadLayers > tuning.GPUOffloadLayers {
				return EffectiveProfile{}, ErrInvalidSelection
			}
			tuning.GPUOffloadLayers = *overrides.GPUOffloadLayers
		}
		if overrides.MaximumMemoryBytes != nil {
			if *overrides.MaximumMemoryBytes > budget || *overrides.MaximumMemoryBytes < tuning.EstimatedMemoryBytes {
				return EffectiveProfile{}, ErrInvalidSelection
			}
			budget = *overrides.MaximumMemoryBytes
		}
	}
	return EffectiveProfile{Profile: profile, Tuning: tuning, MemoryBudgetBytes: budget}, nil
}

func sortedUniqueSlugs(values []string) bool {
	previous := ""
	for _, value := range values {
		if !slugPattern.MatchString(value) || value <= previous {
			return false
		}
		previous = value
	}
	return true
}

func contains(values []string, wanted string) bool {
	index := sort.SearchStrings(values, wanted)
	return index < len(values) && values[index] == wanted
}

func validHTTPSURL(value string) bool {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" ||
		len(value) > 512 || strings.ContainsAny(value, "\x00\r\n") {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	return host != "localhost" && !strings.HasSuffix(host, ".local") && net.ParseIP(host) == nil &&
		(parsed.Port() == "" || parsed.Port() == "443")
}

func validModelID(value string) bool {
	if len(value) > 192 || !modelPattern.MatchString(value) || strings.Contains(value, "://") || strings.ContainsRune(value, '\\') ||
		strings.HasPrefix(value, "/") || (len(value) >= 3 && value[1] == ':' && value[2] == '/') {
		return false
	}
	namespace, remainder, found := strings.Cut(value, ":")
	if !found || namespace == "http" || namespace == "https" || namespace == "file" || namespace == "ftp" ||
		namespace == "ssh" || namespace == "data" {
		return false
	}
	for _, segment := range strings.Split(remainder, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
		if net.ParseIP(segment) != nil {
			return false
		}
	}
	return true
}

func checkedAdd(left, right uint64) (uint64, bool) {
	if right > math.MaxUint64-left {
		return 0, true
	}
	return left + right, false
}

func recoveredMemory(baseline, recovery uint64) bool {
	tolerance := uint64(64 << 20)
	if percentage := baseline / 10; percentage > tolerance {
		tolerance = percentage
	}
	ceiling, overflow := checkedAdd(baseline, tolerance)
	return !overflow && recovery <= ceiling
}

func sha256Digest(raw []byte) string {
	digest := sha256.Sum256(raw)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func wrapInvalid(err error) error {
	if err == nil {
		return ErrInvalidCatalog
	}
	return fmt.Errorf("%w: %v", ErrInvalidCatalog, err)
}
