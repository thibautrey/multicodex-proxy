package runtimebenchmark

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/thibautrey/multivibe/provider-agent/runtimebackend"
)

const (
	maximumOllamaResponseBytes = 8 << 20
	maximumOllamaLineBytes     = 1 << 20
	maximumOllamaVersionBytes  = 4 << 10
	maximumOllamaTagsBytes     = 1 << 20
	maximumOllamaTagModels     = 256
)

var ollamaModelPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}:[a-z0-9][a-z0-9._-]{0,63}$`)
var ollamaVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

type OllamaOptions struct {
	BaseURL                  string
	Model                    string
	ExpectedCanonicalModelID string
	ExpectedModelDigest      string
	ExpectedModelBytes       uint64
	ExpectedVersion          string
	KeepAlive                time.Duration
	RequestTimeout           time.Duration
	MemorySampleInterval     time.Duration
	AllowInducedOOM          bool
	Now                      func() time.Time
}

// OllamaHarness is a loopback-only reference adapter. It never accepts prompt
// text: the request body is derived solely from SyntheticRequest.TermIDs.
type OllamaHarness struct {
	baseURL                  url.URL
	model                    string
	expectedCanonicalModelID string
	expectedModelDigest      string
	expectedModelBytes       uint64
	expectedVersion          string
	keepAlive                time.Duration
	requestTimeout           time.Duration
	memorySampleInterval     time.Duration
	allowInducedOOM          bool
	client                   *http.Client
	now                      func() time.Time
	versionMutex             sync.Mutex
	versionVerified          bool
	modelMutex               sync.Mutex
	modelVerified            bool
}

func NewOllamaHarness(options OllamaOptions) (*OllamaHarness, error) {
	parsed, err := url.Parse(options.BaseURL)
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, ErrInvalid
	}
	ip := net.ParseIP(parsed.Hostname())
	port, portErr := strconv.ParseUint(parsed.Port(), 10, 16)
	if ip == nil || !ip.IsLoopback() || portErr != nil || port == 0 || !ollamaModelPattern.MatchString(options.Model) ||
		!validModelID(options.ExpectedCanonicalModelID) || !digestPattern.MatchString(options.ExpectedModelDigest) ||
		options.ExpectedModelBytes == 0 || !ollamaVersionPattern.MatchString(options.ExpectedVersion) {
		return nil, ErrInvalid
	}
	keepAlive := options.KeepAlive
	if keepAlive == 0 {
		keepAlive = 10 * time.Minute
	}
	requestTimeout := options.RequestTimeout
	if requestTimeout == 0 {
		requestTimeout = 30 * time.Minute
	}
	if keepAlive < time.Minute || keepAlive > time.Hour || requestTimeout < time.Second || requestTimeout > time.Hour {
		return nil, ErrInvalid
	}
	memorySampleInterval := options.MemorySampleInterval
	if memorySampleInterval == 0 {
		memorySampleInterval = 10 * time.Millisecond
	}
	if memorySampleInterval < time.Millisecond || memorySampleInterval > time.Second {
		return nil, ErrInvalid
	}
	now := options.Now
	if now == nil {
		now = time.Now
	}
	dialer := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return dialer.DialContext(ctx, network, parsed.Host)
		},
		DisableCompression: true,
		MaxIdleConns:       2,
		IdleConnTimeout:    30 * time.Second,
	}
	return &OllamaHarness{
		baseURL: *parsed, model: options.Model, expectedCanonicalModelID: options.ExpectedCanonicalModelID,
		expectedModelDigest: options.ExpectedModelDigest, expectedModelBytes: options.ExpectedModelBytes,
		expectedVersion: options.ExpectedVersion,
		keepAlive:       keepAlive, requestTimeout: requestTimeout, memorySampleInterval: memorySampleInterval,
		allowInducedOOM: options.AllowInducedOOM, now: now,
		client: &http.Client{
			Transport:     transport,
			CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect rejected") },
		},
	}, nil
}

func (harness *OllamaHarness) BackendID() string { return OllamaManagedRuntime }

func (harness *OllamaHarness) Load(ctx context.Context, workload SyntheticWorkload) error {
	if harness == nil || workload.RuntimeID != harness.BackendID() || !validModelID(workload.ModelID) ||
		!digestPattern.MatchString(workload.ModelContentDigest) || workload.ModelID != harness.expectedCanonicalModelID ||
		workload.ModelContentDigest != harness.expectedModelDigest || validateRuntimeSettings(workload.RequestedRuntime) != nil {
		return ErrInvalid
	}
	if err := harness.ensureVersion(ctx); err != nil {
		return err
	}
	if err := harness.ensureModel(ctx); err != nil {
		return err
	}
	payload := ollamaGenerateRequest{
		Model: harness.model, Prompt: "", Stream: false, KeepAlive: durationString(harness.keepAlive),
		Options: ollamaGenerateOptions{
			Seed: ReproducibleSeed, Temperature: 0, NumPredict: 0,
			NumCtx: int(workload.RequestedRuntime.ContextTokens), NumBatch: int(workload.RequestedRuntime.BatchSize),
			NumGPU: int(workload.RequestedRuntime.GPUOffloadLayers),
		},
	}
	return harness.postBounded(ctx, "/api/generate", payload)
}

func (harness *OllamaHarness) RunSynthetic(ctx context.Context, request SyntheticRequest, emit func(Event) error) (RunSummary, error) {
	if harness == nil || emit == nil || !idPattern.MatchString(request.ExecutionID) || request.Dataset != SyntheticDataset ||
		request.Seed != ReproducibleSeed || request.TemperatureMilli != ReproducibleTemperature ||
		len(request.TermIDs) < 32 || len(request.TermIDs) > int(maximumSyntheticTerms) || request.MaximumTokens < 1 ||
		request.MaximumTokens > maximumOutputTokens || validateRuntimeSettings(request.RequestedRuntime) != nil ||
		!reflect.DeepEqual(request.TermIDs, syntheticTermIDs(request.Seed, uint32(len(request.TermIDs)))) {
		return RunSummary{}, ErrInvalid
	}
	if request.InduceOOM && !harness.allowInducedOOM {
		return RunSummary{}, ErrDestructiveDisabled
	}
	if err := harness.ensureVersion(ctx); err != nil {
		return RunSummary{}, err
	}
	if err := harness.ensureModel(ctx); err != nil {
		return RunSummary{}, err
	}
	payload := ollamaGenerateRequest{
		Model: harness.model, Prompt: publicSyntheticPrompt(request.TermIDs), Stream: true,
		KeepAlive: durationString(harness.keepAlive), Raw: true,
		Options: ollamaGenerateOptions{
			Seed: request.Seed, Temperature: 0, NumPredict: int(request.MaximumTokens),
			NumCtx: int(request.RequestedRuntime.ContextTokens), NumBatch: int(request.RequestedRuntime.BatchSize),
			NumGPU: int(request.RequestedRuntime.GPUOffloadLayers),
		},
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return RunSummary{}, ErrInvalid
	}
	requestContext, cancel := context.WithTimeout(ctx, harness.requestTimeout)
	defer cancel()
	httpRequest, err := http.NewRequestWithContext(requestContext, http.MethodPost, harness.endpoint("/api/generate"), bytes.NewReader(raw))
	if err != nil {
		return RunSummary{}, ErrInvalid
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	response, err := harness.client.Do(httpRequest)
	if err != nil {
		return RunSummary{}, normalizeOllamaError(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return RunSummary{}, classifyOllamaHTTP(response)
	}
	samplingStop := make(chan struct{})
	samplingResult := make(chan ollamaRunMemoryObservation, 1)
	go func() {
		samplingResult <- harness.sampleMemoryDuringRun(requestContext, samplingStop)
	}()
	stopSampling := sync.OnceValue(func() ollamaRunMemoryObservation {
		close(samplingStop)
		return <-samplingResult
	})
	defer stopSampling()
	scanner := bufio.NewScanner(io.LimitReader(response.Body, maximumOllamaResponseBytes+1))
	scanner.Buffer(make([]byte, 4096), maximumOllamaLineBytes)
	var totalBytes int
	var firstOutputAt, completedAt time.Time
	var final ollamaGenerateResponse
	var streamErr error
	for scanner.Scan() {
		line := scanner.Bytes()
		totalBytes += len(line) + 1
		if totalBytes > maximumOllamaResponseBytes {
			streamErr = ErrProtocol
			break
		}
		var item ollamaGenerateResponse
		if !completedAt.IsZero() || len(line) == 0 || validateUniqueKeys(line) != nil || json.Unmarshal(line, &item) != nil || item.Error != "" {
			if strings.Contains(strings.ToLower(item.Error), "out of memory") {
				streamErr = runtimebackend.ErrOutOfMemory
				break
			}
			streamErr = ErrProtocol
			break
		}
		observed := harness.now()
		if item.Response != "" && firstOutputAt.IsZero() {
			firstOutputAt = observed
		}
		if item.Done {
			if !completedAt.IsZero() {
				streamErr = ErrProtocol
				break
			}
			completedAt = observed
			final = item
		}
	}
	memory := stopSampling()
	if streamErr != nil {
		return RunSummary{}, streamErr
	}
	if err := scanner.Err(); err != nil {
		if requestContext.Err() != nil {
			return RunSummary{}, normalizeOllamaError(requestContext.Err())
		}
		return RunSummary{}, ErrProtocol
	}
	if memory.Err != nil {
		return RunSummary{}, memory.Err
	}
	if completedAt.IsZero() || firstOutputAt.IsZero() || final.PromptEvalCount < 1 ||
		uint64(final.PromptEvalCount) > request.RequestedRuntime.ContextTokens ||
		final.EvalCount < 1 || final.EvalCount > int(request.MaximumTokens) ||
		final.PromptEvalDuration <= 0 || final.EvalDuration <= 0 || final.TotalDuration <= 0 ||
		final.PromptEvalDuration > math.MaxInt64-final.EvalDuration ||
		final.TotalDuration < final.PromptEvalDuration+final.EvalDuration ||
		memory.Samples == 0 || memory.PeakBytes == 0 || !memory.GPUUseObserved ||
		memory.ContextTokens != request.RequestedRuntime.ContextTokens {
		return RunSummary{}, ErrProtocol
	}
	if err := emit(Event{Kind: EventToken, TokenCount: uint32(final.EvalCount), ObservedAt: firstOutputAt}); err != nil {
		return RunSummary{}, err
	}
	if err := emit(Event{Kind: EventFinal, ObservedAt: completedAt}); err != nil {
		return RunSummary{}, err
	}
	return RunSummary{
		PromptTokens: uint32(final.PromptEvalCount), OutputTokens: uint32(final.EvalCount),
		PromptEvalNanoseconds: uint64(final.PromptEvalDuration), EvalNanoseconds: uint64(final.EvalDuration),
		TotalNanoseconds: uint64(final.TotalDuration), NativeTiming: true,
		SampledPeakMemoryBytes: memory.PeakBytes, MemorySamples: memory.Samples,
		ObservedRuntimeContextTokens: memory.ContextTokens,
	}, nil
}

func (harness *OllamaHarness) MemoryBytes(ctx context.Context) (uint64, error) {
	if harness == nil {
		return 0, ErrInvalid
	}
	if err := harness.ensureVersion(ctx); err != nil {
		return 0, err
	}
	if err := harness.ensureModel(ctx); err != nil {
		return 0, err
	}
	snapshot, err := harness.processSnapshot(ctx)
	return snapshot.TotalVRAMBytes, err
}

type ollamaProcessSnapshot struct {
	TotalVRAMBytes uint64
	ModelPresent   bool
	ModelVRAMBytes uint64
	ContextTokens  uint64
}

type ollamaRunMemoryObservation struct {
	PeakBytes      uint64
	Samples        uint32
	ContextTokens  uint64
	GPUUseObserved bool
	Err            error
}

func (harness *OllamaHarness) processSnapshot(ctx context.Context) (ollamaProcessSnapshot, error) {
	if harness == nil {
		return ollamaProcessSnapshot{}, ErrInvalid
	}
	requestContext, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodGet, harness.endpoint("/api/ps"), nil)
	if err != nil {
		return ollamaProcessSnapshot{}, ErrInvalid
	}
	response, err := harness.client.Do(request)
	if err != nil {
		return ollamaProcessSnapshot{}, normalizeOllamaError(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength > maximumOllamaResponseBytes {
		return ollamaProcessSnapshot{}, ErrProtocol
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maximumOllamaResponseBytes+1))
	if err != nil || len(raw) > maximumOllamaResponseBytes || validateUniqueKeys(raw) != nil {
		return ollamaProcessSnapshot{}, ErrProtocol
	}
	var payload struct {
		Models []struct {
			Name          string `json:"name"`
			Model         string `json:"model"`
			Digest        string `json:"digest"`
			SizeVRAM      uint64 `json:"size_vram"`
			ContextLength uint64 `json:"context_length"`
		} `json:"models"`
	}
	if json.Unmarshal(raw, &payload) != nil || payload.Models == nil || len(payload.Models) > 256 {
		return ollamaProcessSnapshot{}, ErrProtocol
	}
	var snapshot ollamaProcessSnapshot
	for _, model := range payload.Models {
		if model.SizeVRAM > math.MaxUint64-snapshot.TotalVRAMBytes {
			return ollamaProcessSnapshot{}, ErrProtocol
		}
		snapshot.TotalVRAMBytes += model.SizeVRAM
		if model.Name != harness.model && model.Model != harness.model {
			continue
		}
		if snapshot.ModelPresent || model.Name != harness.model || model.Model != harness.model ||
			normalizeOllamaTagDigest(model.Digest) != harness.expectedModelDigest || model.SizeVRAM == 0 ||
			model.ContextLength == 0 || model.ContextLength > maximumContextTokens {
			return ollamaProcessSnapshot{}, ErrProtocol
		}
		snapshot.ModelPresent = true
		snapshot.ModelVRAMBytes = model.SizeVRAM
		snapshot.ContextTokens = model.ContextLength
	}
	return snapshot, nil
}

func (harness *OllamaHarness) sampleMemoryDuringRun(ctx context.Context, stop <-chan struct{}) ollamaRunMemoryObservation {
	if harness == nil || stop == nil || harness.memorySampleInterval < time.Millisecond {
		return ollamaRunMemoryObservation{Err: ErrInvalid}
	}
	observation := ollamaRunMemoryObservation{}
	sample := func() bool {
		snapshot, err := harness.processSnapshot(ctx)
		if err != nil {
			observation.Err = err
			return false
		}
		if !snapshot.ModelPresent {
			return true
		}
		if observation.Samples == math.MaxUint32 ||
			(observation.ContextTokens != 0 && observation.ContextTokens != snapshot.ContextTokens) {
			observation.Err = ErrProtocol
			return false
		}
		observation.Samples++
		observation.ContextTokens = snapshot.ContextTokens
		observation.GPUUseObserved = observation.GPUUseObserved || snapshot.ModelVRAMBytes > 0
		if snapshot.TotalVRAMBytes > observation.PeakBytes {
			observation.PeakBytes = snapshot.TotalVRAMBytes
		}
		return true
	}
	if !sample() {
		return observation
	}
	ticker := time.NewTicker(harness.memorySampleInterval)
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return observation
		case <-ctx.Done():
			if observation.Err == nil && observation.Samples == 0 {
				observation.Err = normalizeOllamaError(ctx.Err())
			}
			return observation
		case <-ticker.C:
			if !sample() {
				return observation
			}
		}
	}
}

func (harness *OllamaHarness) Unload(ctx context.Context, workload SyntheticWorkload) error {
	if harness == nil || workload.RuntimeID != harness.BackendID() || workload.ModelID != harness.expectedCanonicalModelID ||
		workload.ModelContentDigest != harness.expectedModelDigest {
		return ErrInvalid
	}
	if err := harness.ensureVersion(ctx); err != nil {
		return err
	}
	if err := harness.ensureModel(ctx); err != nil {
		return err
	}
	payload := ollamaGenerateRequest{Model: harness.model, Prompt: "", Stream: false, KeepAlive: "0s"}
	if err := harness.postBounded(ctx, "/api/generate", payload); err != nil {
		return err
	}
	deadline := time.NewTimer(10 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		snapshot, err := harness.processSnapshot(ctx)
		if err == nil && !snapshot.ModelPresent {
			return nil
		}
		select {
		case <-ctx.Done():
			return normalizeOllamaError(ctx.Err())
		case <-deadline.C:
			return runtimebackend.ErrTimedOut
		case <-ticker.C:
		}
	}
}

func (harness *OllamaHarness) ensureVersion(ctx context.Context) error {
	if harness == nil || !ollamaVersionPattern.MatchString(harness.expectedVersion) {
		return ErrInvalid
	}
	harness.versionMutex.Lock()
	defer harness.versionMutex.Unlock()
	if harness.versionVerified {
		return nil
	}
	timeout := 5 * time.Second
	if harness.requestTimeout < timeout {
		timeout = harness.requestTimeout
	}
	requestContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodGet, harness.endpoint("/api/version"), nil)
	if err != nil {
		return ErrInvalid
	}
	response, err := harness.client.Do(request)
	if err != nil {
		return normalizeOllamaError(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return classifyOllamaHTTP(response)
	}
	if response.ContentLength > maximumOllamaVersionBytes {
		return ErrProtocol
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maximumOllamaVersionBytes+1))
	if err != nil || len(raw) > maximumOllamaVersionBytes || validateUniqueKeys(raw) != nil {
		return ErrProtocol
	}
	var payload struct {
		Version string `json:"version"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&payload) != nil {
		return ErrProtocol
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) || payload.Version != harness.expectedVersion {
		return ErrProtocol
	}
	harness.versionVerified = true
	return nil
}

type ollamaTagDetails struct {
	ParentModel       string   `json:"parent_model"`
	Format            string   `json:"format"`
	Family            string   `json:"family"`
	Families          []string `json:"families"`
	ParameterSize     string   `json:"parameter_size"`
	QuantizationLevel string   `json:"quantization_level"`
	ContextLength     int64    `json:"context_length,omitempty"`
	EmbeddingLength   int64    `json:"embedding_length,omitempty"`
}

type ollamaTagModel struct {
	Name         string            `json:"name"`
	Model        string            `json:"model"`
	RemoteModel  string            `json:"remote_model,omitempty"`
	RemoteHost   string            `json:"remote_host,omitempty"`
	ModifiedAt   string            `json:"modified_at"`
	Size         uint64            `json:"size"`
	Digest       string            `json:"digest"`
	Details      *ollamaTagDetails `json:"details,omitempty"`
	Capabilities []string          `json:"capabilities,omitempty"`
}

func (harness *OllamaHarness) ensureModel(ctx context.Context) error {
	if harness == nil || !ollamaModelPattern.MatchString(harness.model) ||
		!digestPattern.MatchString(harness.expectedModelDigest) || harness.expectedModelBytes == 0 {
		return ErrInvalid
	}
	harness.modelMutex.Lock()
	defer harness.modelMutex.Unlock()
	if harness.modelVerified {
		return nil
	}
	timeout := 5 * time.Second
	if harness.requestTimeout < timeout {
		timeout = harness.requestTimeout
	}
	requestContext, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodGet, harness.endpoint("/api/tags"), nil)
	if err != nil {
		return ErrInvalid
	}
	response, err := harness.client.Do(request)
	if err != nil {
		return normalizeOllamaError(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return classifyOllamaHTTP(response)
	}
	if response.ContentLength > maximumOllamaTagsBytes {
		return ErrProtocol
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maximumOllamaTagsBytes+1))
	if err != nil || len(raw) > maximumOllamaTagsBytes || validateUniqueKeys(raw) != nil {
		return ErrProtocol
	}
	var payload struct {
		Models []ollamaTagModel `json:"models"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&payload) != nil {
		return ErrProtocol
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) || len(payload.Models) > maximumOllamaTagModels {
		return ErrProtocol
	}
	seen := make(map[string]struct{}, len(payload.Models)*2)
	matches := 0
	for _, model := range payload.Models {
		if !validOllamaTagModel(model) {
			return ErrProtocol
		}
		identifiers := []string{model.Name}
		if model.Model != model.Name {
			identifiers = append(identifiers, model.Model)
		}
		for _, identifier := range identifiers {
			if _, duplicate := seen[identifier]; duplicate {
				return ErrProtocol
			}
			seen[identifier] = struct{}{}
		}
		if model.Name != harness.model && model.Model != harness.model {
			continue
		}
		matches++
		if model.Name != harness.model || model.Model != harness.model || normalizeOllamaTagDigest(model.Digest) != harness.expectedModelDigest ||
			model.Size != harness.expectedModelBytes || model.RemoteModel != "" || model.RemoteHost != "" {
			return ErrProtocol
		}
	}
	if matches != 1 {
		return ErrProtocol
	}
	harness.modelVerified = true
	return nil
}

func validOllamaTagModel(model ollamaTagModel) bool {
	if !safeOllamaTagString(model.Name, 256, false) || !safeOllamaTagString(model.Model, 256, false) ||
		model.Size == 0 || normalizeOllamaTagDigest(model.Digest) == "" || model.Details == nil ||
		!safeOllamaTagString(model.ModifiedAt, 64, false) {
		return false
	}
	if _, err := time.Parse(time.RFC3339Nano, model.ModifiedAt); err != nil {
		return false
	}
	if !safeOllamaTagString(model.Details.ParentModel, 256, true) || !safeOllamaTagString(model.Details.Format, 64, true) ||
		!safeOllamaTagString(model.Details.Family, 128, true) || !safeOllamaTagString(model.Details.ParameterSize, 64, true) ||
		!safeOllamaTagString(model.Details.QuantizationLevel, 64, true) || len(model.Details.Families) > 32 ||
		model.Details.ContextLength < 0 || model.Details.ContextLength > 1<<30 ||
		model.Details.EmbeddingLength < 0 || model.Details.EmbeddingLength > 1<<30 ||
		!safeOllamaTagString(model.RemoteModel, 256, true) || !safeOllamaTagString(model.RemoteHost, 512, true) ||
		len(model.Capabilities) > 32 {
		return false
	}
	for _, family := range model.Details.Families {
		if !safeOllamaTagString(family, 128, false) {
			return false
		}
	}
	capabilities := make(map[string]struct{}, len(model.Capabilities))
	for _, capability := range model.Capabilities {
		if !safeOllamaTagString(capability, 64, false) {
			return false
		}
		if _, duplicate := capabilities[capability]; duplicate {
			return false
		}
		capabilities[capability] = struct{}{}
	}
	return true
}

func normalizeOllamaTagDigest(value string) string {
	if digestPattern.MatchString(value) {
		return value
	}
	if len(value) == 64 {
		for _, character := range value {
			if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
				return ""
			}
		}
		return "sha256:" + value
	}
	return ""
}

func safeOllamaTagString(value string, maximum int, allowEmpty bool) bool {
	if len(value) > maximum || (!allowEmpty && value == "") || !utf8.ValidString(value) {
		return false
	}
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return false
		}
	}
	return true
}

type ollamaGenerateOptions struct {
	Seed        uint64  `json:"seed"`
	Temperature float64 `json:"temperature"`
	NumPredict  int     `json:"num_predict"`
	NumCtx      int     `json:"num_ctx"`
	NumBatch    int     `json:"num_batch"`
	NumGPU      int     `json:"num_gpu"`
}

type ollamaGenerateRequest struct {
	Model     string                `json:"model"`
	Prompt    string                `json:"prompt"`
	Stream    bool                  `json:"stream"`
	KeepAlive string                `json:"keep_alive"`
	Raw       bool                  `json:"raw"`
	Options   ollamaGenerateOptions `json:"options"`
}

type ollamaGenerateResponse struct {
	Response           string `json:"response"`
	Done               bool   `json:"done"`
	Error              string `json:"error"`
	PromptEvalCount    int    `json:"prompt_eval_count"`
	EvalCount          int    `json:"eval_count"`
	PromptEvalDuration int64  `json:"prompt_eval_duration"`
	EvalDuration       int64  `json:"eval_duration"`
	TotalDuration      int64  `json:"total_duration"`
}

func (harness *OllamaHarness) postBounded(ctx context.Context, path string, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return ErrInvalid
	}
	requestContext, cancel := context.WithTimeout(ctx, harness.requestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, harness.endpoint(path), bytes.NewReader(raw))
	if err != nil {
		return ErrInvalid
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := harness.client.Do(request)
	if err != nil {
		return normalizeOllamaError(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return classifyOllamaHTTP(response)
	}
	if response.ContentLength > maximumOllamaResponseBytes {
		return ErrProtocol
	}
	written, err := io.Copy(io.Discard, io.LimitReader(response.Body, maximumOllamaResponseBytes+1))
	if err != nil || written > maximumOllamaResponseBytes {
		return ErrProtocol
	}
	return nil
}

func (harness *OllamaHarness) endpoint(path string) string {
	endpoint := harness.baseURL
	endpoint.Path = path
	return endpoint.String()
}

func publicSyntheticPrompt(terms []uint32) string {
	var builder strings.Builder
	builder.Grow(len(terms)*11 + 64)
	builder.WriteString("MultiVibe public synthetic benchmark term sequence v1:")
	for _, term := range terms {
		_, _ = fmt.Fprintf(&builder, " term-%05d", term)
	}
	return builder.String()
}

func durationString(value time.Duration) string {
	return strconv.FormatInt(int64(value/time.Second), 10) + "s"
}

func classifyOllamaHTTP(response *http.Response) error {
	raw, _ := io.ReadAll(io.LimitReader(response.Body, 64<<10))
	if strings.Contains(strings.ToLower(string(raw)), "out of memory") {
		return runtimebackend.ErrOutOfMemory
	}
	return runtimebackend.ErrCrashed
}

func normalizeOllamaError(err error) error {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return runtimebackend.ErrTimedOut
	case errors.Is(err, context.Canceled):
		return runtimebackend.ErrCancelled
	default:
		return runtimebackend.ErrCrashed
	}
}
