package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	providerControlProtocol     = "multivibe-provider-control-shadow-v1"
	providerControlEnvelope     = "multivibe-provider-control-envelope-v1"
	providerManifestVersion     = "multivibe-provider-manifest-shadow-v1"
	providerEnrollmentStateV1   = "provider-cloud-enrollment-v1"
	providerCompanionVersion    = "0.1.0-shadow"
	maxCloudEnrollmentBodyBytes = 64 * 1024
)

var (
	providerControlSigningDomain = []byte("MultiVibe Provider Control\x00multivibe-provider-control-shadow-v1\x00signed-envelope-v1\x00")
	providerUUID                 = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	providerDigest               = regexp.MustCompile(`^[a-f0-9]{64}$`)
	providerVersion              = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+:/-]{0,63}$`)
	providerModality             = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,31}$`)
	providerEnrollmentToken      = regexp.MustCompile(`^mve_[A-Za-z0-9_-]{43}$`)
	providerDeviceKeyID          = regexp.MustCompile(`^ed25519:[A-Za-z0-9_-]{43}$`)
	providerRuntimeFamilies      = func() map[string]bool {
		families := make(map[string]bool, len(runtimeAdapters))
		for _, adapter := range runtimeAdapters {
			families[adapter.ID] = true
		}
		return families
	}()
	errInvalidCloudEnrollment = errors.New("provider Cloud enrollment request is invalid")
	errCloudAlreadyEnrolled   = errors.New("provider device is already enrolled")
)

type cloudEnrollmentModel struct {
	ReportedID string   `json:"reported_id"`
	Modalities []string `json:"modalities"`
}

type cloudEnrollmentInput struct {
	EnrollmentToken        string                 `json:"enrollment_token"`
	CoreVersion            string                 `json:"core_version"`
	RuntimeFamily          string                 `json:"runtime_family"`
	SelectedModels         []cloudEnrollmentModel `json:"selected_models"`
	DeclaredMaxConcurrency uint64                 `json:"declared_max_concurrency"`
}

type cloudEnrollmentManifest struct {
	ManifestVersion        string                 `json:"manifest_version"`
	ProtocolVersion        string                 `json:"protocol_version"`
	CompanionVersion       string                 `json:"companion_version"`
	CoreVersion            string                 `json:"core_version"`
	RuntimeFamily          string                 `json:"runtime_family"`
	SelectedModels         []cloudEnrollmentModel `json:"selected_models"`
	DeclaredMaxConcurrency uint64                 `json:"declared_max_concurrency"`
}

type cloudEnrollmentChallengeRequest struct {
	ClientNodeID        string                  `json:"client_node_id"`
	DevicePublicKeySPKI string                  `json:"device_public_key_spki"`
	Manifest            cloudEnrollmentManifest `json:"manifest"`
}

type cloudEnrollmentChallenge struct {
	EnrollmentID         string `json:"enrollmentId"`
	ChallengeID          string `json:"challengeId"`
	Nonce                string `json:"nonce"`
	ProviderID           string `json:"providerId"`
	NodeID               string `json:"nodeId"`
	DeviceKeyID          string `json:"deviceKeyId"`
	ManifestDigest       string `json:"manifestDigest"`
	DisclosureVersion    string `json:"disclosureVersion"`
	IssuedAt             string `json:"issuedAt"`
	ExpiresAt            string `json:"expiresAt"`
	State                string `json:"state"`
	RoutingEligible      *bool  `json:"routingEligible"`
	CompensationEligible *bool  `json:"compensationEligible"`
}

type enrollmentProofPayload struct {
	Kind                    string `json:"kind"`
	ProtocolVersion         string `json:"protocolVersion"`
	CanonicalizationVersion string `json:"canonicalizationVersion"`
	EnrollmentID            string `json:"enrollmentId"`
	ChallengeID             string `json:"challengeId"`
	Nonce                   string `json:"nonce"`
	ProviderID              string `json:"providerId"`
	NodeID                  string `json:"nodeId"`
	DeviceKeyID             string `json:"deviceKeyId"`
	ManifestDigest          string `json:"manifestDigest"`
	DisclosureVersion       string `json:"disclosureVersion"`
	IssuedAt                string `json:"issuedAt"`
	ExpiresAt               string `json:"expiresAt"`
}

type providerControlSignature struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"keyId"`
	Value     string `json:"value,omitempty"`
}

type signedEnrollmentProof struct {
	EnvelopeVersion string                   `json:"envelopeVersion"`
	Kind            string                   `json:"kind"`
	Payload         enrollmentProofPayload   `json:"payload"`
	Signature       providerControlSignature `json:"signature"`
}

type cloudEnrollmentView struct {
	SchemaVersion          string `json:"schema_version"`
	Revision               uint64 `json:"revision"`
	State                  string `json:"state"`
	ProviderID             string `json:"provider_id"`
	NodeID                 string `json:"node_id"`
	DeviceKeyID            string `json:"device_key_id"`
	CredentialEpoch        uint64 `json:"credential_epoch"`
	ManifestDigest         string `json:"manifest_digest"`
	RuntimeFamily          string `json:"runtime_family"`
	DeclaredMaxConcurrency uint64 `json:"declared_max_concurrency"`
	CloudAPIOrigin         string `json:"cloud_api_origin"`
	SubmittedAt            string `json:"submitted_at"`
	RoutingEligible        bool   `json:"routing_eligible"`
	CompensationEligible   bool   `json:"compensation_eligible"`
	SafetyProfile          string `json:"safety_profile"`
}

type cloudEnrollmentStore struct {
	mu      sync.Mutex
	path    string
	current *cloudEnrollmentView
}

type cloudEnrollmentService struct {
	enrollMu   sync.Mutex
	baseURL    *url.URL
	client     *http.Client
	identity   *deviceIdentity
	selections *selectionStore
	store      *cloudEnrollmentStore
	now        func() time.Time
}

func cloudAPIURL(raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return nil, errors.New("provider Cloud API URL is invalid")
	}
	production := parsed.Scheme == "https" && parsed.Host == "auth.multivibe.cloud"
	loopback := parsed.Scheme == "http" && parsed.Port() != "" && (parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1")
	if !production && !loopback {
		return nil, errors.New("provider Cloud API URL must be production HTTPS or literal loopback HTTP")
	}
	parsed.Path = ""
	return parsed, nil
}

func newMemoryCloudEnrollmentStore() *cloudEnrollmentStore {
	return &cloudEnrollmentStore{}
}

func openCloudEnrollmentStore(path string) (*cloudEnrollmentStore, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("provider Cloud enrollment state path must be a clean absolute path")
	}
	store := &cloudEnrollmentStore{path: path}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil || !providerPrivateFile(path, info) || info.Size() > 16*1024 {
		return nil, errors.New("provider Cloud enrollment state must be a bounded mode-0600 regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, errors.New("provider Cloud enrollment state cannot be opened")
	}
	defer file.Close()
	var view cloudEnrollmentView
	decoder := json.NewDecoder(io.LimitReader(file, 16*1024+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&view); err != nil || ensureJSONEOF(decoder) != nil || validateCloudEnrollmentView(view) != nil {
		return nil, errors.New("provider Cloud enrollment state is invalid")
	}
	store.current = &view
	return store, nil
}

func validateCloudEnrollmentView(view cloudEnrollmentView) error {
	if view.SchemaVersion != providerEnrollmentStateV1 || view.Revision != 1 || view.State != "submitted" ||
		!providerUUID.MatchString(view.ProviderID) || !providerUUID.MatchString(view.NodeID) ||
		!providerDigest.MatchString(view.ManifestDigest) || !providerDeviceKeyID.MatchString(view.DeviceKeyID) ||
		view.CredentialEpoch < 1 || view.CredentialEpoch > maxRelaySequence || view.RoutingEligible || view.CompensationEligible ||
		view.SafetyProfile != "shadow_only_no_routing_no_compensation" {
		return errors.New("provider Cloud enrollment state is invalid")
	}
	if !providerRuntimeFamilies[view.RuntimeFamily] || view.DeclaredMaxConcurrency < 1 || view.DeclaredMaxConcurrency > 1000 {
		return errors.New("provider Cloud enrollment state is invalid")
	}
	if _, err := cloudAPIURL(view.CloudAPIOrigin); err != nil {
		return errors.New("provider Cloud enrollment state is invalid")
	}
	if _, err := canonicalTimestamp(view.SubmittedAt); err != nil {
		return errors.New("provider Cloud enrollment state is invalid")
	}
	return nil
}

func (store *cloudEnrollmentStore) snapshot() *cloudEnrollmentView {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.current == nil {
		return nil
	}
	copy := *store.current
	return &copy
}

func (store *cloudEnrollmentStore) record(view cloudEnrollmentView) error {
	if err := validateCloudEnrollmentView(view); err != nil {
		return err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.current != nil {
		if *store.current == view {
			return nil
		}
		return errors.New("provider device already has a different Cloud enrollment")
	}
	if store.path != "" {
		encoded, err := json.Marshal(view)
		if err != nil {
			return errors.New("provider Cloud enrollment state cannot be encoded")
		}
		if err := atomicWrite0600(store.path, append(encoded, '\n')); err != nil {
			return errors.New("provider Cloud enrollment state cannot be persisted")
		}
	}
	store.current = &view
	return nil
}

func newCloudEnrollmentService(baseURL *url.URL, client *http.Client, identity *deviceIdentity, selections *selectionStore, store *cloudEnrollmentStore) *cloudEnrollmentService {
	boundedClient := *client
	boundedClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	if boundedClient.Timeout <= 0 || boundedClient.Timeout > 10*time.Second {
		boundedClient.Timeout = 10 * time.Second
	}
	return &cloudEnrollmentService{baseURL: baseURL, client: &boundedClient, identity: identity, selections: selections, store: store, now: time.Now}
}

func normalizeEnrollmentInput(input cloudEnrollmentInput, selected []string) (cloudEnrollmentManifest, error) {
	if !providerEnrollmentToken.MatchString(input.EnrollmentToken) || !providerVersion.MatchString(input.CoreVersion) ||
		!providerRuntimeFamilies[input.RuntimeFamily] || input.DeclaredMaxConcurrency < 1 || input.DeclaredMaxConcurrency > 1000 ||
		len(input.SelectedModels) < 1 || len(input.SelectedModels) > 100 || len(input.SelectedModels) != len(selected) {
		return cloudEnrollmentManifest{}, errInvalidCloudEnrollment
	}
	models := append([]cloudEnrollmentModel(nil), input.SelectedModels...)
	for index := range models {
		model := &models[index]
		if !validSelectedModelID(model.ReportedID) || len(model.Modalities) < 1 || len(model.Modalities) > 16 {
			return cloudEnrollmentManifest{}, errInvalidCloudEnrollment
		}
		sort.Strings(model.Modalities)
		for modalityIndex, modality := range model.Modalities {
			if !providerModality.MatchString(modality) || (modalityIndex > 0 && modality == model.Modalities[modalityIndex-1]) {
				return cloudEnrollmentManifest{}, errInvalidCloudEnrollment
			}
		}
	}
	sort.Slice(models, func(left, right int) bool { return models[left].ReportedID < models[right].ReportedID })
	selectedCopy := append([]string(nil), selected...)
	sort.Strings(selectedCopy)
	for index, model := range models {
		if model.ReportedID != selectedCopy[index] || (index > 0 && model.ReportedID == models[index-1].ReportedID) {
			return cloudEnrollmentManifest{}, errInvalidCloudEnrollment
		}
	}
	return cloudEnrollmentManifest{
		ManifestVersion: providerManifestVersion, ProtocolVersion: providerControlProtocol,
		CompanionVersion: providerCompanionVersion, CoreVersion: input.CoreVersion, RuntimeFamily: input.RuntimeFamily,
		SelectedModels: models, DeclaredMaxConcurrency: input.DeclaredMaxConcurrency,
	}, nil
}

func deterministicClientNodeID(publicKeySPKI string) string {
	digest := sha256.Sum256([]byte("MultiVibe provider client node\x00" + publicKeySPKI))
	bytes := digest[:16]
	bytes[6] = (bytes[6] & 0x0f) | 0x50
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	hexValue := hex.EncodeToString(bytes)
	return fmt.Sprintf("%s-%s-%s-%s-%s", hexValue[:8], hexValue[8:12], hexValue[12:16], hexValue[16:20], hexValue[20:])
}

func canonicalTimestamp(value string) (time.Time, error) {
	parsed, err := time.Parse("2006-01-02T15:04:05.000Z", value)
	if err != nil || parsed.Format("2006-01-02T15:04:05.000Z") != value {
		return time.Time{}, errors.New("provider Cloud timestamp is invalid")
	}
	return parsed, nil
}

func validateChallenge(challenge cloudEnrollmentChallenge, expectedKeyID string, now time.Time) error {
	decodedNonce, nonceErr := base64.RawURLEncoding.DecodeString(challenge.Nonce)
	issuedAt, issuedErr := canonicalTimestamp(challenge.IssuedAt)
	expiresAt, expiresErr := canonicalTimestamp(challenge.ExpiresAt)
	if !providerUUID.MatchString(challenge.EnrollmentID) || !providerUUID.MatchString(challenge.ChallengeID) ||
		!providerUUID.MatchString(challenge.ProviderID) || !providerUUID.MatchString(challenge.NodeID) ||
		challenge.DeviceKeyID != expectedKeyID || !providerDigest.MatchString(challenge.ManifestDigest) ||
		!providerVersion.MatchString(challenge.DisclosureVersion) || nonceErr != nil || len(decodedNonce) != 32 ||
		base64.RawURLEncoding.EncodeToString(decodedNonce) != challenge.Nonce || issuedErr != nil || expiresErr != nil ||
		!expiresAt.After(issuedAt) || expiresAt.Sub(issuedAt) > 10*time.Minute || now.Before(issuedAt.Add(-30*time.Second)) || !now.Before(expiresAt) ||
		challenge.State != "challenge_issued" || challenge.RoutingEligible == nil || *challenge.RoutingEligible ||
		challenge.CompensationEligible == nil || *challenge.CompensationEligible {
		return errors.New("provider Cloud enrollment challenge is invalid")
	}
	return nil
}

func enrollmentPayloadMap(payload enrollmentProofPayload) map[string]any {
	return map[string]any{
		"kind": payload.Kind, "protocolVersion": payload.ProtocolVersion,
		"canonicalizationVersion": payload.CanonicalizationVersion, "enrollmentId": payload.EnrollmentID,
		"challengeId": payload.ChallengeID, "nonce": payload.Nonce, "providerId": payload.ProviderID,
		"nodeId": payload.NodeID, "deviceKeyId": payload.DeviceKeyID, "manifestDigest": payload.ManifestDigest,
		"disclosureVersion": payload.DisclosureVersion, "issuedAt": payload.IssuedAt, "expiresAt": payload.ExpiresAt,
	}
}

func (identity *deviceIdentity) signEnrollmentProof(challenge cloudEnrollmentChallenge) (signedEnrollmentProof, error) {
	payload := enrollmentProofPayload{
		Kind: "enrollment_proof", ProtocolVersion: providerControlProtocol, CanonicalizationVersion: relayCanonicalization,
		EnrollmentID: challenge.EnrollmentID, ChallengeID: challenge.ChallengeID, Nonce: challenge.Nonce,
		ProviderID: challenge.ProviderID, NodeID: challenge.NodeID, DeviceKeyID: challenge.DeviceKeyID,
		ManifestDigest: challenge.ManifestDigest, DisclosureVersion: challenge.DisclosureVersion,
		IssuedAt: challenge.IssuedAt, ExpiresAt: challenge.ExpiresAt,
	}
	unsigned := map[string]any{
		"envelopeVersion": providerControlEnvelope, "kind": "enrollment_proof", "payload": enrollmentPayloadMap(payload),
		"signature": map[string]any{"algorithm": relaySignatureAlgorithm, "keyId": challenge.DeviceKeyID},
	}
	canonical, err := canonicalJSON(unsigned, maxRelayEnvelopeBytes)
	if err != nil {
		return signedEnrollmentProof{}, err
	}
	identity.mu.Lock()
	signature := ed25519.Sign(identity.privateKey, append(append([]byte{}, providerControlSigningDomain...), canonical...))
	identity.mu.Unlock()
	return signedEnrollmentProof{
		EnvelopeVersion: providerControlEnvelope, Kind: "enrollment_proof", Payload: payload,
		Signature: providerControlSignature{Algorithm: relaySignatureAlgorithm, KeyID: challenge.DeviceKeyID, Value: base64.RawURLEncoding.EncodeToString(signature)},
	}, nil
}

func enrollmentIdempotencyKey(label, token string, body []byte) string {
	digest := sha256.New()
	_, _ = digest.Write([]byte("MultiVibe provider Cloud enrollment\x00" + label + "\x00" + token + "\x00"))
	_, _ = digest.Write(body)
	return label + "-" + hex.EncodeToString(digest.Sum(nil))
}

func (service *cloudEnrollmentService) postJSON(ctx context.Context, path, bearer, idempotency string, body any, expectedStatus int, output any) error {
	encoded, err := json.Marshal(body)
	if err != nil || len(encoded) > maxCloudEnrollmentBodyBytes {
		return errors.New("provider Cloud enrollment request cannot be encoded")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, service.baseURL.String()+path, bytes.NewReader(encoded))
	if err != nil {
		return errors.New("provider Cloud enrollment request cannot be created")
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("idempotency-key", idempotency)
	if bearer != "" {
		request.Header.Set("authorization", "Bearer "+bearer)
	}
	response, err := service.client.Do(request)
	if err != nil {
		return errors.New("provider Cloud enrollment request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != expectedStatus {
		return errors.New("provider Cloud enrollment was rejected")
	}
	if declared := response.Header.Get("content-length"); declared != "" {
		declaredBytes, err := strconv.ParseInt(declared, 10, 64)
		if err != nil || declaredBytes < 0 || declaredBytes > maxCloudEnrollmentBodyBytes {
			return errors.New("provider Cloud enrollment response is invalid")
		}
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxCloudEnrollmentBodyBytes+1))
	if err != nil || len(raw) > maxCloudEnrollmentBodyBytes {
		return errors.New("provider Cloud enrollment response is invalid")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil || ensureJSONEOF(decoder) != nil {
		return errors.New("provider Cloud enrollment response is invalid")
	}
	return nil
}

func (service *cloudEnrollmentService) enroll(ctx context.Context, input cloudEnrollmentInput) (cloudEnrollmentView, error) {
	service.enrollMu.Lock()
	defer service.enrollMu.Unlock()
	if service.store.snapshot() != nil {
		return cloudEnrollmentView{}, errCloudAlreadyEnrolled
	}
	selection := service.selections.snapshot()
	manifest, err := normalizeEnrollmentInput(input, selection.SelectedModels)
	if err != nil {
		return cloudEnrollmentView{}, err
	}
	keyID, publicKeySPKI := service.identity.publicIdentity()
	challengeRequest := cloudEnrollmentChallengeRequest{
		ClientNodeID: deterministicClientNodeID(publicKeySPKI), DevicePublicKeySPKI: publicKeySPKI, Manifest: manifest,
	}
	challengeBody, _ := json.Marshal(challengeRequest)
	var challenge cloudEnrollmentChallenge
	if err := service.postJSON(
		ctx, "/provider/v1/enrollment-challenges", input.EnrollmentToken,
		enrollmentIdempotencyKey("challenge", input.EnrollmentToken, challengeBody), challengeRequest, http.StatusCreated, &challenge,
	); err != nil {
		return cloudEnrollmentView{}, err
	}
	now := service.now().UTC()
	if err := validateChallenge(challenge, keyID, now); err != nil {
		return cloudEnrollmentView{}, err
	}
	proof, err := service.identity.signEnrollmentProof(challenge)
	if err != nil {
		return cloudEnrollmentView{}, errors.New("provider Cloud enrollment proof cannot be signed")
	}
	proofBody, _ := json.Marshal(proof)
	var node struct {
		ProviderID           string `json:"providerId"`
		NodeID               string `json:"nodeId"`
		DeviceKeyID          string `json:"deviceKeyId"`
		State                string `json:"state"`
		CredentialEpoch      uint64 `json:"credentialEpoch"`
		ManifestDigest       string `json:"manifestDigest"`
		RoutingEligible      *bool  `json:"routingEligible"`
		CompensationEligible *bool  `json:"compensationEligible"`
	}
	if err := service.postJSON(
		ctx, "/provider/v1/enrollments/"+challenge.EnrollmentID+"/proofs", "",
		enrollmentIdempotencyKey("proof", input.EnrollmentToken, proofBody), proof, http.StatusOK, &node,
	); err != nil {
		return cloudEnrollmentView{}, err
	}
	if node.ProviderID != challenge.ProviderID || node.NodeID != challenge.NodeID || node.DeviceKeyID != keyID ||
		node.State != "submitted" || node.CredentialEpoch < 1 || node.CredentialEpoch > maxRelaySequence ||
		node.ManifestDigest != challenge.ManifestDigest || node.RoutingEligible == nil || *node.RoutingEligible ||
		node.CompensationEligible == nil || *node.CompensationEligible {
		return cloudEnrollmentView{}, errors.New("provider Cloud enrollment node response is invalid")
	}
	view := cloudEnrollmentView{
		SchemaVersion: providerEnrollmentStateV1, Revision: 1, State: "submitted",
		ProviderID: node.ProviderID, NodeID: node.NodeID, DeviceKeyID: node.DeviceKeyID,
		CredentialEpoch: node.CredentialEpoch, ManifestDigest: node.ManifestDigest,
		RuntimeFamily: manifest.RuntimeFamily, DeclaredMaxConcurrency: manifest.DeclaredMaxConcurrency,
		CloudAPIOrigin: service.baseURL.String(), SubmittedAt: now.Truncate(time.Millisecond).Format("2006-01-02T15:04:05.000Z"),
		RoutingEligible: false, CompensationEligible: false, SafetyProfile: "shadow_only_no_routing_no_compensation",
	}
	if err := service.store.record(view); err != nil {
		return cloudEnrollmentView{}, err
	}
	return view, nil
}
