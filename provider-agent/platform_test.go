package main

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

func TestDetectHostCapabilityAcceptsOnlyAppleSiliconOnMacOS(t *testing.T) {
	var observedName string
	var observedArguments []string
	runner := func(ctx context.Context, name string, arguments ...string) ([]byte, error) {
		if _, ok := ctx.Deadline(); !ok {
			t.Fatal("Apple memory probe did not receive a timeout")
		}
		observedName = name
		observedArguments = append([]string(nil), arguments...)
		return []byte("17179869184\n"), nil
	}
	supported := detectHostCapability(context.Background(), "darwin", "arm64", runner)
	if !supported.Supported || supported.Profile != "apple-silicon" || supported.Accelerator != "metal" || supported.AcceleratorMemoryBytes != 8*1024*1024*1024 {
		t.Fatalf("unexpected Apple Silicon capability: %#v", supported)
	}
	if observedName != "sysctl" || !reflect.DeepEqual(observedArguments, []string{"-n", "hw.memsize"}) {
		t.Fatalf("unexpected Apple memory probe: %q %#v", observedName, observedArguments)
	}
	unsupported := detectHostCapability(context.Background(), "darwin", "amd64", runner)
	if unsupported.Supported || unsupported.Reason != "macOS hosts require Apple Silicon" {
		t.Fatalf("unexpected Intel Mac capability: %#v", unsupported)
	}
}

func TestDetectHostCapabilityRequiresModernNVIDIAOnLinuxAMD64(t *testing.T) {
	var observedName string
	var observedArguments []string
	runner := func(_ context.Context, name string, arguments ...string) ([]byte, error) {
		observedName = name
		observedArguments = append([]string(nil), arguments...)
		return []byte("NVIDIA GeForce RTX 3060 Ti, 8192, 8.6\nNVIDIA L4, 23034, 8.9\n"), nil
	}
	capability := detectHostCapability(context.Background(), "linux", "amd64", runner)
	if !capability.Supported || capability.Profile != "linux-nvidia" || capability.Accelerator != "cuda" {
		t.Fatalf("unexpected Linux NVIDIA capability: %#v", capability)
	}
	if observedName != "nvidia-smi" || !reflect.DeepEqual(observedArguments, []string{
		"--query-gpu=name,memory.total,compute_cap", "--format=csv,noheader,nounits",
	}) {
		t.Fatalf("unexpected NVIDIA probe: %q %#v", observedName, observedArguments)
	}
	if len(capability.GPUs) != 2 || capability.GPUs[0].Name != "NVIDIA GeForce RTX 3060 Ti" || capability.GPUs[0].MemoryMiB != 8192 {
		t.Fatalf("unexpected GPU projection: %#v", capability.GPUs)
	}
}

func TestDetectHostCapabilityFailsClosed(t *testing.T) {
	for _, testCase := range []struct {
		name   string
		goos   string
		goarch string
		output string
		err    error
		reason string
	}{
		{name: "unsupported OS", goos: "windows", goarch: "amd64", reason: "supported hosts"},
		{name: "missing driver", goos: "linux", goarch: "amd64", err: errors.New("missing"), reason: "working NVIDIA driver"},
		{name: "old GPU", goos: "linux", goarch: "amd64", output: "Tesla P100, 16280, 6.0\n", reason: "compute capability 7.0"},
		{name: "malformed", goos: "linux", goarch: "amd64", output: "NVIDIA GPU, unknown, 8.6\n", reason: "response is invalid"},
		{name: "missing Apple memory", goos: "darwin", goarch: "arm64", err: errors.New("missing"), reason: "memory capacity is unavailable"},
		{name: "invalid Apple memory", goos: "darwin", goarch: "arm64", output: "0\n", reason: "memory response is invalid"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			capability := detectHostCapability(context.Background(), testCase.goos, testCase.goarch, func(context.Context, string, ...string) ([]byte, error) {
				return []byte(testCase.output), testCase.err
			})
			if capability.Supported || !strings.Contains(capability.Reason, testCase.reason) {
				t.Fatalf("unexpected unsupported capability: %#v", capability)
			}
		})
	}
}

func TestParseDarwinUnifiedMemoryRejectsMalformedOrUnboundedValues(t *testing.T) {
	for _, valid := range []string{"4294967296", "68719476736\n", "1099511627776\n"} {
		if _, err := parseDarwinUnifiedMemory([]byte(valid)); err != nil {
			t.Fatalf("valid Apple unified memory %q was rejected: %v", valid, err)
		}
	}
	for _, invalid := range []string{
		"", "0\n", "4294967295\n", "068719476736\n", "+68719476736\n",
		"68719476736 bytes\n", "68719476736\n\n", "1099511631872\n",
		"18446744073709551616\n", strings.Repeat("9", maximumDarwinMemoryProbeBytes+1),
	} {
		if _, err := parseDarwinUnifiedMemory([]byte(invalid)); err == nil {
			t.Fatalf("invalid Apple unified memory response %q was accepted", invalid)
		}
	}
	if _, err := parseDarwinUnifiedMemory([]byte{'1', 0, '2'}); err == nil {
		t.Fatal("NUL-containing Apple unified memory response was accepted")
	}
}

func TestParseNVIDIACapabilitiesRejectsMalformedOrUnboundedValues(t *testing.T) {
	for _, input := range []string{
		"\n",
		"GPU only, 8192\n",
		"GPU\nname, 8192, 8.6\n",
		"GPU, 64, 8.6\n",
		"GPU, 8192, unknown\n",
	} {
		if _, err := parseNVIDIACapabilities([]byte(input)); err == nil {
			t.Fatalf("accepted invalid NVIDIA capability response %q", input)
		}
	}
}

func TestSelectNVIDIACUDADeviceRequiresOneAvailableCanonicalPin(t *testing.T) {
	capability := hostCapability{
		Supported:    true,
		OS:           "linux",
		Architecture: "amd64",
		Accelerator:  "cuda",
		GPUs: []nvidiaGPUCapability{
			{Name: "GPU 0", MemoryMiB: 8192, ComputeCapability: 8.6},
			{Name: "GPU 1", MemoryMiB: 24576, ComputeCapability: 8.9},
		},
	}
	selected, err := selectNVIDIACUDADevice(capability, "")
	if err != nil || selected.CUDADevice != 0 {
		t.Fatalf("default CUDA device was not GPU 0: %#v %v", selected, err)
	}
	selected, err = selectNVIDIACUDADevice(capability, "1")
	if err != nil || selected.CUDADevice != 1 {
		t.Fatalf("configured CUDA device was not selected: %#v %v", selected, err)
	}
	for _, invalid := range []string{"0,1", "0,0", "2", "00", "+1", "gpu0"} {
		if _, err := selectNVIDIACUDADevice(capability, invalid); err == nil {
			t.Fatalf("invalid or non-sharded CUDA pin %q was accepted", invalid)
		}
	}
	withoutGPU := capability
	withoutGPU.GPUs = nil
	if _, err := selectNVIDIACUDADevice(withoutGPU, ""); err == nil {
		t.Fatal("default CUDA device was accepted without a GPU inventory")
	}
}

func TestProviderAgentOnlyRequiresComputeCapabilityForManagedFeatures(t *testing.T) {
	unsupported := hostCapability{Supported: false, Reason: "no supported accelerator"}
	if err := requireProviderComputeCapability(unsupported, false); err != nil {
		t.Fatalf("general provider-agent startup was coupled to managed compute: %v", err)
	}
	if err := requireProviderComputeCapability(unsupported, true); err == nil {
		t.Fatal("managed compute accepted an unsupported host")
	}
	if err := requireProviderComputeCapability(hostCapability{Supported: true}, true); err == nil {
		t.Fatal("managed compute accepted a host without accelerator memory capacity")
	}
	valid := hostCapability{
		Supported: true, Profile: "apple-silicon", OS: "darwin", Architecture: "arm64", Accelerator: "metal",
		AcceleratorMemoryBytes: 8 * 1024 * 1024 * 1024,
	}
	if err := requireProviderComputeCapability(valid, true); err != nil {
		t.Fatalf("supported managed compute was rejected: %v", err)
	}
}
