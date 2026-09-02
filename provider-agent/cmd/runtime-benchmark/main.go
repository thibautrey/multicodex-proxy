package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"runtime"
	"time"

	"github.com/thibautrey/multivibe/provider-agent/runtimebenchmark"
	"github.com/thibautrey/multivibe/provider-agent/runtimeprofile"
)

var runtimeBenchmarkVersion = "development"

type options struct {
	run              bool
	catalogPath      string
	modelCatalogPath string
	profileID        string
	ollamaURL        string
	storePath        string
	runs             uint
	warmups          uint
	syntheticTerms   uint
	outputTokens     uint
	timeout          time.Duration
}

func main() {
	if len(os.Args) == 2 && os.Args[1] == "version" {
		fmt.Println(runtimeBenchmarkVersion)
		return
	}
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "runtime benchmark failed:", err)
		os.Exit(1)
	}
}

func run(arguments []string) error {
	var options options
	flags := flag.NewFlagSet("multivibe-runtime-benchmark", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	flags.BoolVar(&options.run, "run", false, "explicitly authorize this synthetic benchmark")
	flags.StringVar(&options.catalogPath, "catalog", "", "absolute path to provider-runtime-profiles.json")
	flags.StringVar(&options.modelCatalogPath, "model-catalog", "", "absolute path to provider-model-catalog.json")
	flags.StringVar(&options.profileID, "profile", "", "exact reviewed profile id")
	flags.StringVar(&options.ollamaURL, "ollama-url", "http://127.0.0.1:18081", "loopback Ollama API URL")
	flags.StringVar(&options.storePath, "store", "", "optional absolute 0600 result-store path")
	flags.UintVar(&options.runs, "runs", 5, "measured warm runs (3-50)")
	flags.UintVar(&options.warmups, "warmups", 1, "unmeasured warmup runs (0-10)")
	flags.UintVar(&options.syntheticTerms, "synthetic-terms", 256, "public deterministic input-term count")
	flags.UintVar(&options.outputTokens, "output-tokens", 64, "maximum generated-token count")
	flags.DurationVar(&options.timeout, "timeout", 5*time.Minute, "timeout for each run")
	if err := flags.Parse(arguments); err != nil || flags.NArg() != 0 {
		return runtimebenchmark.ErrInvalid
	}
	if !options.run {
		return runtimebenchmark.ErrDisabled
	}
	if options.catalogPath == "" || options.modelCatalogPath == "" || options.profileID == "" ||
		options.runs > uint(^uint32(0)) || options.warmups > uint(^uint32(0)) ||
		options.syntheticTerms > uint(^uint32(0)) || options.outputTokens > uint(^uint32(0)) ||
		options.timeout < time.Millisecond {
		return runtimebenchmark.ErrInvalid
	}
	catalog, err := runtimeprofile.Load(options.catalogPath, runtimeprofile.MigrationDefaults{})
	if err != nil {
		return err
	}
	var profile *runtimeprofile.Profile
	for index := range catalog.Profiles {
		if catalog.Profiles[index].ID == options.profileID {
			profile = &catalog.Profiles[index]
			break
		}
	}
	if profile == nil || !supportsBenchmarkProfile(*profile) || !supportsBenchmarkPlatform(*profile, runtime.GOOS, runtime.GOARCH) {
		return runtimeprofile.ErrNoCompatible
	}
	modelCatalog, err := loadBenchmarkModelCatalog(options.modelCatalogPath)
	if err != nil {
		return err
	}
	model, err := modelCatalog.modelForProfile(catalog, *profile)
	if err != nil {
		return err
	}
	expectedOllamaVersion, err := loadBenchmarkOllamaExpectation(options.catalogPath, *profile)
	if err != nil {
		return err
	}
	harness, err := runtimebenchmark.NewOllamaHarness(runtimebenchmark.OllamaOptions{
		BaseURL: options.ollamaURL, Model: model.OllamaModel, ExpectedCanonicalModelID: profile.Model.ID,
		ExpectedModelDigest: profile.Model.ContentDigest, ExpectedModelBytes: profile.Model.ArtifactBytes,
		ExpectedVersion: expectedOllamaVersion,
		RequestTimeout:  options.timeout,
	})
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	spec := runtimebenchmark.Spec{
		SchemaVersion:       runtimebenchmark.SpecVersion,
		Enabled:             true,
		BenchmarkID:         fmt.Sprintf("bench-%d", now.UnixNano()),
		ProfileID:           profile.ID,
		ProfileDigest:       profile.ProfileDigest,
		CatalogDigest:       catalog.CatalogDigest,
		ModelID:             profile.Model.ID,
		ModelContentDigest:  profile.Model.ContentDigest,
		HardwareClass:       profile.Hardware.Class,
		RuntimeID:           profile.Runtime.BackendID,
		Dataset:             runtimebenchmark.SyntheticDataset,
		Runs:                uint32(options.runs),
		WarmupRuns:          uint32(options.warmups),
		SyntheticTerms:      uint32(options.syntheticTerms),
		MaximumOutputTokens: uint32(options.outputTokens),
		RequestedRuntime: runtimebenchmark.RuntimeSettings{
			ContextTokens: profile.Tuning.ContextTokens, BatchSize: profile.Tuning.BatchSize,
			Parallelism: profile.Tuning.Parallelism, GPUOffloadLayers: profile.Tuning.GPUOffloadLayers,
		},
		Seed:                   runtimebenchmark.ReproducibleSeed,
		TemperatureMilli:       runtimebenchmark.ReproducibleTemperature,
		RunTimeoutMilliseconds: uint64(options.timeout / time.Millisecond),
		InduceOOM:              false,
	}
	result, err := runtimebenchmark.NewRunner(runtimebenchmark.Options{}).Run(context.Background(), harness, spec)
	if err != nil {
		return err
	}
	if options.storePath != "" {
		store, err := runtimebenchmark.NewStore(options.storePath, runtimebenchmark.StoreOptions{})
		if err != nil {
			return err
		}
		if err := store.Append(result); err != nil {
			return err
		}
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(result); err != nil {
		return errors.New("runtime benchmark output failed")
	}
	return nil
}
