package runtimebenchmark

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

const testOllamaVersion = "0.33.2"
const testOllamaCanonicalModel = "hf:qwen/qwen2.5-0.5b-instruct"
const testOllamaModelDigest = "sha256:a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67"
const testOllamaModelBytes = uint64(397821319)
const testOllamaTagsResponse = `{"models":[{"name":"qwen2.5:0.5b","model":"qwen2.5:0.5b","modified_at":"2026-09-02T12:00:00Z","size":397821319,"digest":"a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67","details":{"parent_model":"","format":"gguf","family":"qwen2","families":["qwen2"],"parameter_size":"494.03M","quantization_level":"Q4_K_M","context_length":32768,"embedding_length":896},"capabilities":["completion","tools"]}]}`

func testOllamaOptions(baseURL string) OllamaOptions {
	return OllamaOptions{
		BaseURL: baseURL, Model: "qwen2.5:0.5b", ExpectedCanonicalModelID: testOllamaCanonicalModel,
		ExpectedModelDigest: testOllamaModelDigest, ExpectedModelBytes: testOllamaModelBytes,
		ExpectedVersion: testOllamaVersion, MemorySampleInterval: time.Millisecond,
	}
}

func testRuntimeSettings() RuntimeSettings {
	return RuntimeSettings{ContextTokens: 8192, BatchSize: 128, Parallelism: 1, GPUOffloadLayers: 24}
}

func TestOllamaHarnessAcceptsOnlyNumericLoopbackAndStrictModelReference(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"models":[]}`))
	}))
	defer server.Close()
	if _, err := NewOllamaHarness(testOllamaOptions(server.URL)); err != nil {
		t.Fatal(err)
	}
	for _, baseURL := range []string{
		"http://localhost:18081", "http://192.168.1.10:18081", "https://127.0.0.1:18081",
		"http://user:pass@127.0.0.1:18081", "http://127.0.0.1:18081/path", "http://127.0.0.1",
	} {
		options := testOllamaOptions(baseURL)
		if _, err := NewOllamaHarness(options); err == nil {
			t.Fatalf("unsafe Ollama target was accepted: %s", baseURL)
		}
	}
	unsafeModel := testOllamaOptions(server.URL)
	unsafeModel.Model = "https://example.test/model"
	if _, err := NewOllamaHarness(unsafeModel); err == nil {
		t.Fatal("URL-shaped Ollama model was accepted")
	}
	missingVersion := testOllamaOptions(server.URL)
	missingVersion.ExpectedVersion = ""
	if _, err := NewOllamaHarness(missingVersion); err == nil {
		t.Fatal("missing expected Ollama version was accepted")
	}
}

func TestOllamaHarnessUsesOnlyDeterministicPublicSyntheticInput(t *testing.T) {
	var mu sync.Mutex
	var prompts []string
	var generateOptions []ollamaGenerateOptions
	psObserved := make(chan struct{})
	var psOnce sync.Once
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/version":
			_, _ = response.Write([]byte(`{"version":"0.33.2"}`))
		case "/api/tags":
			_, _ = response.Write([]byte(testOllamaTagsResponse))
		case "/api/generate":
			var payload ollamaGenerateRequest
			if json.NewDecoder(request.Body).Decode(&payload) != nil {
				http.Error(response, "bad request", http.StatusBadRequest)
				return
			}
			mu.Lock()
			prompts = append(prompts, payload.Prompt)
			generateOptions = append(generateOptions, payload.Options)
			mu.Unlock()
			if payload.Stream {
				_, _ = response.Write([]byte("{\"response\":\"x\",\"done\":false}\n"))
				if flusher, ok := response.(http.Flusher); ok {
					flusher.Flush()
				}
				select {
				case <-psObserved:
				case <-time.After(2 * time.Second):
					t.Error("generation was not sampled through /api/ps while the stream was open")
					return
				}
				_, _ = response.Write([]byte("{\"done\":true,\"prompt_eval_count\":57,\"eval_count\":8,\"prompt_eval_duration\":20000000,\"eval_duration\":40000000,\"total_duration\":75000000}\n"))
				return
			}
			_, _ = response.Write([]byte(`{"done":true}`))
		case "/api/ps":
			psOnce.Do(func() { close(psObserved) })
			_, _ = response.Write([]byte(`{"models":[{"name":"qwen2.5:0.5b","model":"qwen2.5:0.5b","digest":"a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67","size_vram":2147483648,"context_length":8192}]}`))
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	harness, err := NewOllamaHarness(testOllamaOptions(server.URL))
	if err != nil {
		t.Fatal(err)
	}
	terms := syntheticTermIDs(ReproducibleSeed, 32)
	request := SyntheticRequest{
		ExecutionID: "benchmark:test:run:0", Dataset: SyntheticDataset, TermIDs: terms,
		MaximumTokens: 8, RequestedRuntime: testRuntimeSettings(), Seed: ReproducibleSeed, TemperatureMilli: 0,
	}
	var events []Event
	summary, err := harness.RunSynthetic(context.Background(), request, func(event Event) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if summary.PromptTokens != 57 || summary.OutputTokens != 8 || !summary.NativeTiming ||
		summary.PromptEvalNanoseconds != 20_000_000 || summary.EvalNanoseconds != 40_000_000 ||
		summary.TotalNanoseconds != 75_000_000 || summary.SampledPeakMemoryBytes != 2*benchmarkGiB ||
		summary.MemorySamples < 1 || summary.ObservedRuntimeContextTokens != 8192 || len(events) != 2 ||
		events[0].Kind != EventToken || events[0].TokenCount != 8 || events[1].Kind != EventFinal {
		t.Fatalf("unexpected normalized stream: %#v %#v", summary, events)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(prompts) != 1 || prompts[0] != publicSyntheticPrompt(terms) ||
		!strings.HasPrefix(prompts[0], "MultiVibe public synthetic benchmark term sequence v1:") {
		t.Fatalf("non-deterministic synthetic prompt: %#v", prompts)
	}
	if len(generateOptions) != 1 || generateOptions[0].NumCtx != 8192 || generateOptions[0].NumBatch != 128 ||
		generateOptions[0].NumGPU != 24 || generateOptions[0].NumPredict != 8 {
		t.Fatalf("reviewed runtime settings were not sent exactly: %#v", generateOptions)
	}
	second := publicSyntheticPrompt(syntheticTermIDs(ReproducibleSeed, 32))
	if !reflect.DeepEqual(prompts[0], second) {
		t.Fatal("synthetic prompt changed for seed 7")
	}
}

func TestOllamaHarnessRejectsUnattestedRuntimeSnapshots(t *testing.T) {
	validSnapshot := `{"models":[{"name":"qwen2.5:0.5b","model":"qwen2.5:0.5b","digest":"a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67","size_vram":2147483648,"context_length":8192}]}`
	tests := map[string]string{
		"digest":  strings.Replace(validSnapshot, "a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67", strings.Repeat("0", 64), 1),
		"context": strings.Replace(validSnapshot, `"context_length":8192`, `"context_length":4096`, 1),
		"no-gpu":  strings.Replace(validSnapshot, `"size_vram":2147483648`, `"size_vram":0`, 1),
		"absent":  `{"models":[]}`,
		"null":    `null`,
	}
	for name, snapshot := range tests {
		t.Run(name, func(t *testing.T) {
			psObserved := make(chan struct{})
			var psOnce sync.Once
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				response.Header().Set("Content-Type", "application/json")
				switch request.URL.Path {
				case "/api/version":
					_, _ = response.Write([]byte(`{"version":"0.33.2"}`))
				case "/api/tags":
					_, _ = response.Write([]byte(testOllamaTagsResponse))
				case "/api/ps":
					psOnce.Do(func() { close(psObserved) })
					_, _ = response.Write([]byte(snapshot))
				case "/api/generate":
					_, _ = response.Write([]byte("{\"response\":\"x\",\"done\":false}\n"))
					if flusher, ok := response.(http.Flusher); ok {
						flusher.Flush()
					}
					select {
					case <-psObserved:
					case <-request.Context().Done():
						return
					}
					_, _ = response.Write([]byte("{\"done\":true,\"prompt_eval_count\":57,\"eval_count\":8,\"prompt_eval_duration\":20000000,\"eval_duration\":40000000,\"total_duration\":75000000}\n"))
				default:
					http.NotFound(response, request)
				}
			}))
			defer server.Close()
			options := testOllamaOptions(server.URL)
			options.RequestTimeout = time.Second
			harness, err := NewOllamaHarness(options)
			if err != nil {
				t.Fatal(err)
			}
			_, err = harness.RunSynthetic(context.Background(), SyntheticRequest{
				ExecutionID: "benchmark:test:runtime-snapshot", Dataset: SyntheticDataset,
				TermIDs: syntheticTermIDs(ReproducibleSeed, 32), MaximumTokens: 8,
				RequestedRuntime: testRuntimeSettings(), Seed: ReproducibleSeed,
				TemperatureMilli: ReproducibleTemperature,
			}, func(Event) error { return nil })
			if !errors.Is(err, ErrProtocol) {
				t.Fatalf("unattested runtime snapshot was accepted: %v", err)
			}
		})
	}
}

func TestOllamaHarnessNeverEnablesInducedOOMByDefault(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("network must not be reached")
	}))
	defer server.Close()
	harness, err := NewOllamaHarness(testOllamaOptions(server.URL))
	if err != nil {
		t.Fatal(err)
	}
	_, err = harness.RunSynthetic(context.Background(), SyntheticRequest{
		ExecutionID: "benchmark:test:oom", Dataset: SyntheticDataset,
		TermIDs: syntheticTermIDs(ReproducibleSeed, 32), MaximumTokens: 8,
		RequestedRuntime: testRuntimeSettings(), Seed: ReproducibleSeed, TemperatureMilli: 0, InduceOOM: true,
	}, func(Event) error { return nil })
	if !errors.Is(err, ErrDestructiveDisabled) {
		t.Fatalf("induced OOM was not gated: %v", err)
	}
}

func TestOllamaHarnessVerifiesExactVersionBeforeRuntimeRequests(t *testing.T) {
	var mu sync.Mutex
	var paths []string
	servedVersion := "0.33.1"
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		mu.Lock()
		paths = append(paths, request.URL.Path)
		currentVersion := servedVersion
		mu.Unlock()
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/version":
			_, _ = response.Write([]byte(`{"version":"` + currentVersion + `"}`))
		case "/api/tags":
			_, _ = response.Write([]byte(testOllamaTagsResponse))
		case "/api/ps":
			_, _ = response.Write([]byte(`{"models":[]}`))
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	harness, err := NewOllamaHarness(testOllamaOptions(server.URL))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := harness.MemoryBytes(context.Background()); !errors.Is(err, ErrProtocol) {
		t.Fatalf("mismatched Ollama version was accepted: %v", err)
	}
	mu.Lock()
	if !reflect.DeepEqual(paths, []string{"/api/version"}) {
		t.Fatalf("runtime endpoint was reached before version verification: %#v", paths)
	}
	paths = nil
	servedVersion = testOllamaVersion
	mu.Unlock()
	if _, err := harness.MemoryBytes(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := harness.MemoryBytes(context.Background()); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	defer mu.Unlock()
	if !reflect.DeepEqual(paths, []string{"/api/version", "/api/tags", "/api/ps", "/api/ps"}) {
		t.Fatalf("version was not verified once before runtime operations: %#v", paths)
	}
}

func TestOllamaHarnessRejectsSubstitutedOrAmbiguousModelBeforeRuntimeUse(t *testing.T) {
	tests := map[string]string{
		"digest mismatch": strings.Replace(testOllamaTagsResponse, "a8b0c51577010a279d933d14c2a8ab4b268079d44c5c8830c0a93900f1827c67", strings.Repeat("0", 64), 1),
		"size mismatch":   strings.Replace(testOllamaTagsResponse, "397821319", "397821320", 1),
		"ambiguous alias": strings.Replace(testOllamaTagsResponse, `"model":"qwen2.5:0.5b"`, `"model":"attacker:latest"`, 1),
		"duplicate model": strings.Replace(testOllamaTagsResponse, `]}`, `,`+strings.TrimSuffix(strings.TrimPrefix(testOllamaTagsResponse, `{"models":[`), `]}`)+`]}`, 1),
		"unknown field":   strings.Replace(testOllamaTagsResponse, `"details":`, `"unreviewed":true,"details":`, 1),
	}
	for name, tags := range tests {
		t.Run(name, func(t *testing.T) {
			var mu sync.Mutex
			var paths []string
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				mu.Lock()
				paths = append(paths, request.URL.Path)
				mu.Unlock()
				response.Header().Set("Content-Type", "application/json")
				switch request.URL.Path {
				case "/api/version":
					_, _ = response.Write([]byte(`{"version":"0.33.2"}`))
				case "/api/tags":
					_, _ = response.Write([]byte(tags))
				default:
					_, _ = response.Write([]byte(`{"models":[]}`))
				}
			}))
			defer server.Close()
			harness, err := NewOllamaHarness(testOllamaOptions(server.URL))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := harness.MemoryBytes(context.Background()); !errors.Is(err, ErrProtocol) {
				t.Fatalf("substituted model was accepted: %v", err)
			}
			mu.Lock()
			defer mu.Unlock()
			if !reflect.DeepEqual(paths, []string{"/api/version", "/api/tags"}) {
				t.Fatalf("runtime endpoint was reached with an unattested model: %#v", paths)
			}
		})
	}
}
