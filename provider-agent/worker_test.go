package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const (
	workerTestClaimLifetime  = 60 * time.Second
	workerTestSessionRefresh = 14 * time.Minute
	workerTestPollInterval   = 2 * time.Second
	workerTestMaxBodyBytes   = 70 * 1024
	workerTestMaxOutputBytes = 64 * 1024
)

var providerWorkerSessionToken = regexp.MustCompile(`^mwt_[A-Za-z0-9_-]{43}$`)

type workerTestSessionPayload struct {
	Kind                    string `json:"kind"`
	ProtocolVersion         string `json:"protocolVersion"`
	CanonicalizationVersion string `json:"canonicalizationVersion"`
	ProviderID              string `json:"providerId"`
	NodeID                  string `json:"nodeId"`
	DeviceKeyID             string `json:"deviceKeyId"`
	CredentialEpoch         uint64 `json:"credentialEpoch"`
	Sequence                uint64 `json:"sequence"`
	ManifestDigest          string `json:"manifestDigest"`
	IssuedAt                string `json:"issuedAt"`
	ExpiresAt               string `json:"expiresAt"`
	TestOnly                bool   `json:"testOnly"`
	RoutingEligible         bool   `json:"routingEligible"`
	CompensationEligible    bool   `json:"compensationEligible"`
}

type signedWorkerTestSession struct {
	EnvelopeVersion string                   `json:"envelopeVersion"`
	Kind            string                   `json:"kind"`
	Payload         workerTestSessionPayload `json:"payload"`
	Signature       providerControlSignature `json:"signature"`
}

type workerTestSessionView struct {
	SessionToken           string `json:"sessionToken"`
	ExpiresAt              string `json:"expiresAt"`
	NodeID                 string `json:"nodeId"`
	TestOnly               bool   `json:"testOnly"`
	RoutingEffectsApplied  bool   `json:"routingEffectsApplied"`
	MonetaryEffectsApplied bool   `json:"monetaryEffectsApplied"`
}

type workerTestClaim struct {
	JobID     string `json:"jobId"`
	NodeID    string `json:"nodeId"`
	Model     string `json:"model"`
	Prompt    string `json:"prompt"`
	ExpiresAt string `json:"expiresAt"`
	TestOnly  bool   `json:"testOnly"`
}

type workerTestPollResponse struct {
	Job *workerTestClaim `json:"job"`
}

type workerTestService struct {
	baseURL    *url.URL
	cloud      *http.Client
	runtime    *http.Client
	identity   *deviceIdentity
	enrollment *cloudEnrollmentStore
	selections *selectionStore
	runtimes   *runtimeEndpointStore
	now        func() time.Time
}

func newWorkerTestService(baseURL *url.URL, client *http.Client, identity *deviceIdentity, enrollment *cloudEnrollmentStore, selections *selectionStore, runtimes *runtimeEndpointStore) *workerTestService {
	cloud := *client
	cloud.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	if cloud.Timeout <= 0 || cloud.Timeout > 10*time.Second {
		cloud.Timeout = 10 * time.Second
	}
	runtime := *client
	runtime.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	runtime.Timeout = 2 * time.Minute
	return &workerTestService{baseURL: baseURL, cloud: &cloud, runtime: &runtime, identity: identity, enrollment: enrollment, selections: selections, runtimes: runtimes, now: time.Now}
}

func workerTestPayloadMap(payload workerTestSessionPayload) map[string]any {
	return map[string]any{
		"kind": payload.Kind, "protocolVersion": payload.ProtocolVersion,
		"canonicalizationVersion": payload.CanonicalizationVersion, "providerId": payload.ProviderID,
		"nodeId": payload.NodeID, "deviceKeyId": payload.DeviceKeyID,
		"credentialEpoch": payload.CredentialEpoch, "sequence": payload.Sequence,
		"manifestDigest": payload.ManifestDigest, "issuedAt": payload.IssuedAt, "expiresAt": payload.ExpiresAt,
		"testOnly": payload.TestOnly, "routingEligible": payload.RoutingEligible,
		"compensationEligible": payload.CompensationEligible,
	}
}

func (service *workerTestService) signedSession(view cloudEnrollmentView) (signedWorkerTestSession, error) {
	now := service.now().UTC().Truncate(time.Millisecond)
	service.identity.mu.Lock()
	defer service.identity.mu.Unlock()
	if service.identity.sequence >= maxRelaySequence {
		return signedWorkerTestSession{}, errors.New("worker test session sequence is exhausted")
	}
	service.identity.sequence++
	if service.identity.path != "" {
		if err := service.identity.persistLocked(); err != nil {
			service.identity.sequence--
			return signedWorkerTestSession{}, errors.New("worker test session sequence cannot be persisted")
		}
	}
	payload := workerTestSessionPayload{
		Kind: "worker_test_session", ProtocolVersion: providerControlProtocol,
		CanonicalizationVersion: relayCanonicalization, ProviderID: view.ProviderID, NodeID: view.NodeID,
		DeviceKeyID: view.DeviceKeyID, CredentialEpoch: view.CredentialEpoch, Sequence: service.identity.sequence,
		ManifestDigest: view.ManifestDigest, IssuedAt: now.Format("2006-01-02T15:04:05.000Z"),
		ExpiresAt: now.Add(workerTestClaimLifetime).Format("2006-01-02T15:04:05.000Z"),
		TestOnly:  true, RoutingEligible: false, CompensationEligible: false,
	}
	unsigned := map[string]any{
		"envelopeVersion": providerControlEnvelope, "kind": payload.Kind, "payload": workerTestPayloadMap(payload),
		"signature": map[string]any{"algorithm": relaySignatureAlgorithm, "keyId": view.DeviceKeyID},
	}
	canonical, err := canonicalJSON(unsigned, maxRelayEnvelopeBytes)
	if err != nil {
		return signedWorkerTestSession{}, errors.New("worker test session cannot be encoded")
	}
	signature := ed25519.Sign(service.identity.privateKey, append(append([]byte{}, providerControlSigningDomain...), canonical...))
	return signedWorkerTestSession{
		EnvelopeVersion: providerControlEnvelope, Kind: payload.Kind, Payload: payload,
		Signature: providerControlSignature{Algorithm: relaySignatureAlgorithm, KeyID: view.DeviceKeyID, Value: base64.RawURLEncoding.EncodeToString(signature)},
	}, nil
}

func (service *workerTestService) requestJSON(ctx context.Context, method, path, bearer string, input any, output any) error {
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil || len(encoded) > workerTestMaxBodyBytes {
			return errors.New("worker test request is invalid")
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, service.baseURL.String()+path, body)
	if err != nil {
		return errors.New("worker test request is invalid")
	}
	request.Header.Set("accept", "application/json")
	if input != nil {
		request.Header.Set("content-type", "application/json")
	}
	if bearer != "" {
		request.Header.Set("authorization", "Bearer "+bearer)
	}
	response, err := service.cloud.Do(request)
	if err != nil {
		return errors.New("worker test Cloud request failed")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return errors.New("worker test Cloud request was rejected")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, workerTestMaxBodyBytes+1))
	if err != nil || len(raw) > workerTestMaxBodyBytes {
		return errors.New("worker test Cloud response is invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil || ensureJSONEOF(decoder) != nil {
		return errors.New("worker test Cloud response is invalid")
	}
	return nil
}

func (service *workerTestService) openSession(ctx context.Context, enrollment cloudEnrollmentView) (workerTestSessionView, error) {
	envelope, err := service.signedSession(enrollment)
	if err != nil {
		return workerTestSessionView{}, err
	}
	var session workerTestSessionView
	if err := service.requestJSON(ctx, http.MethodPost, "/provider/v1/worker-test-sessions", "", envelope, &session); err != nil {
		return workerTestSessionView{}, err
	}
	expiresAt, timestampErr := canonicalTimestamp(session.ExpiresAt)
	if !providerWorkerSessionToken.MatchString(session.SessionToken) || session.NodeID != enrollment.NodeID || timestampErr != nil ||
		!expiresAt.After(service.now()) || expiresAt.Sub(service.now()) > 15*time.Minute || !session.TestOnly ||
		session.RoutingEffectsApplied || session.MonetaryEffectsApplied {
		return workerTestSessionView{}, errors.New("worker test session response is invalid")
	}
	return session, nil
}

func (service *workerTestService) poll(ctx context.Context, token string) (*workerTestClaim, error) {
	var response workerTestPollResponse
	if err := service.requestJSON(ctx, http.MethodPost, "/provider/v1/worker-test-poll", token, nil, &response); err != nil {
		return nil, err
	}
	if response.Job == nil {
		return nil, nil
	}
	claim := response.Job
	expiresAt, err := canonicalTimestamp(claim.ExpiresAt)
	selected := service.selections.snapshot().SelectedModels
	selectedMatch := false
	for _, model := range selected {
		if model == claim.Model {
			selectedMatch = true
			break
		}
	}
	if !providerUUID.MatchString(claim.JobID) || !providerUUID.MatchString(claim.NodeID) ||
		claim.NodeID != enrollmentNodeID(service.enrollment) || !validSelectedModelID(claim.Model) || !selectedMatch ||
		claim.Prompt != "Reply with exactly MULTIVIBE_WORKER_OK." || err != nil || !expiresAt.After(service.now()) || !claim.TestOnly {
		return nil, errors.New("worker test claim is invalid")
	}
	return claim, nil
}

func enrollmentNodeID(store *cloudEnrollmentStore) string {
	view := store.snapshot()
	if view == nil {
		return ""
	}
	return view.NodeID
}

func (service *workerTestService) runtimeEndpoint(ctx context.Context, family, model string) (runtimeEndpoint, error) {
	for _, endpoint := range service.runtimes.configured() {
		if endpoint.AdapterID == family {
			return endpoint, nil
		}
	}
	for _, adapter := range runtimeAdapterRegistry().Adapters {
		if adapter.ID != family {
			continue
		}
		for _, candidate := range adapter.Candidates {
			models, err := probeRuntimeCatalog(ctx, adapter, candidate, service.runtime)
			if err != nil {
				continue
			}
			for _, detected := range models {
				if detected == model {
					return runtimeEndpoint{AdapterID: family, Endpoint: candidate.Endpoint}, nil
				}
			}
		}
	}
	return runtimeEndpoint{}, errors.New("worker test runtime is unavailable")
}

func (service *workerTestService) infer(ctx context.Context, enrollment cloudEnrollmentView, claim workerTestClaim) (string, uint64, uint64, error) {
	endpoint, err := service.runtimeEndpoint(ctx, enrollment.RuntimeFamily, claim.Model)
	if err != nil {
		return "", 0, 0, err
	}
	body, _ := json.Marshal(map[string]any{
		"model": claim.Model, "messages": []map[string]string{{"role": "user", "content": claim.Prompt}},
		"stream": false, "temperature": 0, "max_tokens": 32,
	})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.Endpoint+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		return "", 0, 0, errors.New("worker test runtime request is invalid")
	}
	request.Header.Set("accept", "application/json")
	request.Header.Set("content-type", "application/json")
	if endpoint.BearerToken != "" {
		request.Header.Set("authorization", "Bearer "+endpoint.BearerToken)
	}
	response, err := service.runtime.Do(request)
	if err != nil {
		return "", 0, 0, errors.New("worker test runtime request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", 0, 0, errors.New("worker test runtime rejected the request")
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, workerTestMaxOutputBytes+1))
	if err != nil || len(raw) > workerTestMaxOutputBytes {
		return "", 0, 0, errors.New("worker test runtime response is invalid")
	}
	var result struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     uint64 `json:"prompt_tokens"`
			CompletionTokens uint64 `json:"completion_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(raw, &result); err != nil || len(result.Choices) != 1 ||
		strings.TrimSpace(result.Choices[0].Message.Content) == "" ||
		len([]byte(result.Choices[0].Message.Content)) > workerTestMaxOutputBytes {
		return "", 0, 0, errors.New("worker test runtime response is invalid")
	}
	return strings.TrimSpace(result.Choices[0].Message.Content), result.Usage.PromptTokens, result.Usage.CompletionTokens, nil
}

func (service *workerTestService) complete(ctx context.Context, token string, claim workerTestClaim, output string, inputTokens, outputTokens uint64, inferenceErr error) error {
	var body any
	if inferenceErr == nil {
		body = map[string]any{"outcome": "completed", "output_text": output, "input_tokens": inputTokens, "output_tokens": outputTokens}
	} else {
		body = map[string]any{"outcome": "failed", "error_code": "local_inference_failed"}
	}
	var result map[string]any
	return service.requestJSON(ctx, http.MethodPost, "/provider/v1/worker-test-jobs/"+claim.JobID+"/complete", token, body, &result)
}

func (service *workerTestService) run(ctx context.Context) {
	var token string
	var refreshAt time.Time
	for {
		if err := ctx.Err(); err != nil {
			return
		}
		enrollment := service.enrollment.snapshot()
		if enrollment == nil {
			token = ""
			if !waitWorkerTest(ctx, workerTestPollInterval) {
				return
			}
			continue
		}
		if token == "" || !service.now().Before(refreshAt) {
			session, err := service.openSession(ctx, *enrollment)
			if err != nil {
				token = ""
				if !waitWorkerTest(ctx, workerTestPollInterval) {
					return
				}
				continue
			}
			token = session.SessionToken
			refreshAt = service.now().Add(workerTestSessionRefresh)
		}
		claim, err := service.poll(ctx, token)
		if err != nil {
			token = ""
			if !waitWorkerTest(ctx, workerTestPollInterval) {
				return
			}
			continue
		}
		if claim != nil {
			output, inputTokens, outputTokens, inferenceErr := service.infer(ctx, *enrollment, *claim)
			if service.complete(ctx, token, *claim, output, inputTokens, outputTokens, inferenceErr) != nil {
				token = ""
			}
		}
		if !waitWorkerTest(ctx, workerTestPollInterval) {
			return
		}
	}
}

func waitWorkerTest(ctx context.Context, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
