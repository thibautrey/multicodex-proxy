package main

import (
	"errors"
	"math"
	"path/filepath"
	"strings"
	"time"
)

const capacityPolicySchemaVersion = "provider-capacity-policy-v1"

var errInvalidCapacityPolicy = errors.New("provider capacity policy is invalid")

// capacityPolicyDocument is the operator-facing input. Pointer fields make an
// omitted choice different from an explicit zero (which disables downloads or
// model-set changes where documented).
type capacityPolicyDocument struct {
	SchemaVersion                string  `json:"schema_version"`
	GPUUtilizationPercent        *uint8  `json:"gpu_utilization_percent"`
	GPUVRAMPercent               *uint8  `json:"gpu_vram_percent"`
	MaxDiskBytes                 *uint64 `json:"max_disk_bytes"`
	ModelStoragePath             string  `json:"model_storage_path"`
	MaxDownloadBytesPerDay       *uint64 `json:"max_download_bytes_per_day"`
	MinimumModelResidencySeconds *uint64 `json:"minimum_model_residency_seconds"`
	MaxModelChangesPerDay        *uint32 `json:"max_model_changes_per_day"`
	ReserveFreeDiskBytes         *uint64 `json:"reserve_free_disk_bytes"`
}

// capacityPolicy is produced only after every operator choice has been
// validated. It intentionally contains no implicit defaults.
type capacityPolicy struct {
	gpuUtilizationPercent  uint8
	gpuVRAMPercent         uint8
	maxDiskBytes           uint64
	modelStoragePath       string
	maxDownloadBytesPerDay uint64
	minimumModelResidency  time.Duration
	maxModelChangesPerDay  uint32
	reserveFreeDiskBytes   uint64
}

func validateCapacityPolicy(document capacityPolicyDocument) (capacityPolicy, error) {
	if document.SchemaVersion != capacityPolicySchemaVersion ||
		document.GPUUtilizationPercent == nil ||
		document.GPUVRAMPercent == nil ||
		document.MaxDiskBytes == nil ||
		document.MaxDownloadBytesPerDay == nil ||
		document.MinimumModelResidencySeconds == nil ||
		document.MaxModelChangesPerDay == nil ||
		document.ReserveFreeDiskBytes == nil {
		return capacityPolicy{}, errInvalidCapacityPolicy
	}

	policy := capacityPolicy{
		gpuUtilizationPercent:  *document.GPUUtilizationPercent,
		gpuVRAMPercent:         *document.GPUVRAMPercent,
		maxDiskBytes:           *document.MaxDiskBytes,
		modelStoragePath:       document.ModelStoragePath,
		maxDownloadBytesPerDay: *document.MaxDownloadBytesPerDay,
		maxModelChangesPerDay:  *document.MaxModelChangesPerDay,
		reserveFreeDiskBytes:   *document.ReserveFreeDiskBytes,
	}

	residencySeconds := *document.MinimumModelResidencySeconds
	if residencySeconds > uint64(math.MaxInt64/int64(time.Second)) {
		return capacityPolicy{}, errInvalidCapacityPolicy
	}
	policy.minimumModelResidency = time.Duration(residencySeconds) * time.Second

	if err := validateCapacityPolicyValue(policy); err != nil {
		return capacityPolicy{}, err
	}
	return policy, nil
}

func validateCapacityPolicyValue(policy capacityPolicy) error {
	if policy.gpuUtilizationPercent < 1 || policy.gpuUtilizationPercent > 100 ||
		policy.gpuVRAMPercent < 1 || policy.gpuVRAMPercent > 100 ||
		policy.maxDiskBytes == 0 ||
		policy.minimumModelResidency <= 0 ||
		policy.reserveFreeDiskBytes == 0 ||
		!validModelStoragePath(policy.modelStoragePath) {
		return errInvalidCapacityPolicy
	}
	return nil
}

func validModelStoragePath(path string) bool {
	if path == "" || len(path) > 4096 || strings.ContainsRune(path, '\x00') || strings.ContainsAny(path, "\r\n") {
		return false
	}
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return false
	}
	volume := filepath.VolumeName(path)
	return path != volume+string(filepath.Separator)
}
