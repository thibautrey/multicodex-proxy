package main

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unicode"
)

const (
	minimumNVIDIAComputeCapability         = 7.0
	minimumDarwinUnifiedMemoryBytes uint64 = 4 * 1024 * 1024 * 1024
	maximumDarwinUnifiedMemoryBytes uint64 = 1024 * 1024 * 1024 * 1024
	maximumDarwinMemoryProbeBytes          = 32
)

var providerAgentVersion = "dev"

type nvidiaGPUCapability struct {
	Name              string  `json:"name"`
	MemoryMiB         uint64  `json:"memory_mib"`
	ComputeCapability float64 `json:"compute_capability"`
}

type hostCapability struct {
	SchemaVersion string `json:"schema_version"`
	AgentVersion  string `json:"agent_version"`
	Supported     bool   `json:"supported"`
	Profile       string `json:"profile,omitempty"`
	OS            string `json:"os"`
	Architecture  string `json:"architecture"`
	Accelerator   string `json:"accelerator,omitempty"`
	// AcceleratorMemoryBytes is the capacity safe for planning before the
	// operator's gpu_vram_percent policy is applied. On Apple Silicon this is
	// deliberately capped below total unified memory.
	AcceleratorMemoryBytes uint64                `json:"accelerator_memory_bytes,omitempty"`
	GPUs                   []nvidiaGPUCapability `json:"gpus,omitempty"`
	CUDADevice             uint32                `json:"cuda_device,omitempty"`
	Reason                 string                `json:"reason,omitempty"`
}

type platformCommand func(context.Context, string, ...string) ([]byte, error)

func fixedPlatformCommand(ctx context.Context, name string, arguments ...string) ([]byte, error) {
	var candidates []string
	switch name {
	case "nvidia-smi":
		candidates = []string{"/usr/bin/nvidia-smi", "/usr/local/bin/nvidia-smi", "/bin/nvidia-smi"}
	case "sysctl":
		candidates = []string{"/usr/sbin/sysctl"}
	default:
		return nil, errors.New("platform probe command is not approved")
	}
	for _, candidate := range candidates {
		info, err := os.Stat(candidate)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		return exec.CommandContext(ctx, candidate, arguments...).Output()
	}
	return nil, errors.New("platform probe is unavailable at an approved system path")
}

func detectHostCapability(ctx context.Context, goos, goarch string, command platformCommand) hostCapability {
	result := hostCapability{
		SchemaVersion: "multivibe-host-capability-v1",
		AgentVersion:  providerAgentVersion,
		OS:            goos,
		Architecture:  goarch,
	}
	if goos == "darwin" {
		if goarch != "arm64" {
			result.Reason = "macOS hosts require Apple Silicon"
			return result
		}
		probeContext, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		output, err := command(probeContext, "sysctl", "-n", "hw.memsize")
		if err != nil {
			result.Reason = "Apple unified memory capacity is unavailable"
			return result
		}
		unifiedMemoryBytes, err := parseDarwinUnifiedMemory(output)
		if err != nil {
			result.Reason = "the Apple unified memory response is invalid"
			return result
		}
		result.Supported = true
		result.Profile = "apple-silicon"
		result.Accelerator = "metal"
		// Metal and the CPU share physical memory. Until the runtime backend can
		// attest recommendedMaxWorkingSetSize, reserve half for macOS, the CPU
		// workload and memory pressure. The operator policy is applied to this
		// already-conservative capacity later by the planner.
		result.AcceleratorMemoryBytes = unifiedMemoryBytes / 2
		return result
	}
	if goos != "linux" || goarch != "amd64" {
		result.Reason = "supported hosts are Apple Silicon or Linux amd64 with NVIDIA GPUs"
		return result
	}
	probeContext, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	output, err := command(
		probeContext,
		"nvidia-smi",
		"--query-gpu=name,memory.total,compute_cap",
		"--format=csv,noheader,nounits",
	)
	if err != nil {
		result.Reason = "a working NVIDIA driver and nvidia-smi are required"
		return result
	}
	if len(output) == 0 || len(output) > 64*1024 {
		result.Reason = "the NVIDIA capability response is invalid"
		return result
	}
	gpus, err := parseNVIDIACapabilities(output)
	if err != nil {
		result.Reason = "the NVIDIA capability response is invalid"
		return result
	}
	result.GPUs = gpus
	for _, gpu := range gpus {
		if gpu.ComputeCapability < minimumNVIDIAComputeCapability {
			result.Reason = fmt.Sprintf("NVIDIA compute capability %.1f or newer is required", minimumNVIDIAComputeCapability)
			return result
		}
	}
	result.Supported = true
	result.Profile = "linux-nvidia"
	result.Accelerator = "cuda"
	return result
}

func currentHostCapability() hostCapability {
	capability := detectHostCapability(context.Background(), runtime.GOOS, runtime.GOARCH, fixedPlatformCommand)
	if !capability.Supported || capability.Accelerator != "cuda" {
		return capability
	}
	pinned, err := selectNVIDIACUDADevice(capability, strings.TrimSpace(os.Getenv("MULTIVIBE_PROVIDER_CUDA_VISIBLE_DEVICES")))
	if err != nil {
		capability.Supported = false
		capability.Reason = "the configured NVIDIA CUDA device is invalid or unavailable"
		return capability
	}
	return pinned
}

// selectNVIDIACUDADevice binds advertised capacity to the single physical GPU
// exposed to the non-sharded managed Ollama runtime. An empty pin is the
// production default CUDA_VISIBLE_DEVICES=0. Multiple devices must stay
// rejected until a runtime backend explicitly declares and implements
// sharding semantics.
func selectNVIDIACUDADevice(capability hostCapability, value string) (hostCapability, error) {
	if !capability.Supported || capability.Accelerator != "cuda" || len(capability.GPUs) == 0 {
		return hostCapability{}, errors.New("NVIDIA CUDA capability is unavailable")
	}
	device, err := parseNVIDIACUDADevicePin(value)
	if err != nil || uint64(device) >= uint64(len(capability.GPUs)) {
		return hostCapability{}, errors.New("NVIDIA CUDA device pin is invalid")
	}
	capability.CUDADevice = device
	memoryBytes, ok := checkedMultiply(capability.GPUs[device].MemoryMiB, 1024*1024)
	if !ok || memoryBytes == 0 {
		return hostCapability{}, errors.New("NVIDIA CUDA device capacity is invalid")
	}
	capability.AcceleratorMemoryBytes = memoryBytes
	return capability, nil
}

func parseNVIDIACUDADevicePin(value string) (uint32, error) {
	if value == "" {
		return 0, nil
	}
	device, err := strconv.ParseUint(value, 10, 5)
	if err != nil || strconv.FormatUint(device, 10) != value {
		return 0, errors.New("NVIDIA CUDA device pin is invalid")
	}
	return uint32(device), nil
}

func parseDarwinUnifiedMemory(output []byte) (uint64, error) {
	if len(output) == 0 || len(output) > maximumDarwinMemoryProbeBytes || bytes.IndexByte(output, 0) >= 0 {
		return 0, errors.New("Apple unified memory response is invalid")
	}
	value := string(output)
	if strings.HasSuffix(value, "\n") {
		value = strings.TrimSuffix(value, "\n")
	}
	if value == "" || strings.IndexFunc(value, unicode.IsSpace) >= 0 {
		return 0, errors.New("Apple unified memory response is invalid")
	}
	memoryBytes, err := strconv.ParseUint(value, 10, 64)
	if err != nil || strconv.FormatUint(memoryBytes, 10) != value ||
		memoryBytes < minimumDarwinUnifiedMemoryBytes || memoryBytes > maximumDarwinUnifiedMemoryBytes || memoryBytes%4096 != 0 {
		return 0, errors.New("Apple unified memory response is invalid")
	}
	return memoryBytes, nil
}

func parseNVIDIACapabilities(output []byte) ([]nvidiaGPUCapability, error) {
	reader := csv.NewReader(bytes.NewReader(output))
	reader.FieldsPerRecord = 3
	reader.TrimLeadingSpace = true
	records, err := reader.ReadAll()
	if err != nil || len(records) == 0 || len(records) > 32 {
		return nil, errors.New("invalid NVIDIA capability list")
	}
	gpus := make([]nvidiaGPUCapability, 0, len(records))
	for _, record := range records {
		name := strings.TrimSpace(record[0])
		if name == "" || len(name) > 128 || strings.IndexFunc(name, unicode.IsControl) >= 0 {
			return nil, errors.New("invalid NVIDIA GPU name")
		}
		memory, err := strconv.ParseUint(strings.TrimSpace(record[1]), 10, 64)
		if err != nil || memory < 256 || memory > 1024*1024 {
			return nil, errors.New("invalid NVIDIA GPU memory")
		}
		compute, err := strconv.ParseFloat(strings.TrimSpace(record[2]), 64)
		if err != nil || compute < 1 || compute > 99 {
			return nil, errors.New("invalid NVIDIA compute capability")
		}
		gpus = append(gpus, nvidiaGPUCapability{
			Name:              name,
			MemoryMiB:         memory,
			ComputeCapability: compute,
		})
	}
	return gpus, nil
}

func runDoctor(output *os.File) int {
	capability := currentHostCapability()
	encoder := json.NewEncoder(output)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(capability); err != nil {
		return 1
	}
	if !capability.Supported {
		return 2
	}
	return 0
}
