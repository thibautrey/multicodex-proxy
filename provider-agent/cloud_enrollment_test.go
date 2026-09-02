package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const (
	testEnrollmentID = "10000000-0000-4000-8000-000000000001"
	testChallengeID  = "20000000-0000-4000-8000-000000000002"
	testProviderID   = "30000000-0000-4000-8000-000000000003"
	testNodeID       = "40000000-0000-4000-8000-000000000004"
)

func enrollmentRequestBody(token string) string {
	encoded, _ := json.Marshal(cloudEnrollmentInput{
		EnrollmentToken: token, CoreVersion: "0.2.0", RuntimeFamily: "omlx",
		SelectedModels:         []cloudEnrollmentModel{{ReportedID: "publisher/model", Modalities: []string{"text"}}},
		DeclaredMaxConcurrency: 4,
	})
	return string(encoded)
}

func verifyEnrollmentProof(t *testing.T, proof signedEnrollmentProof, publicKey ed25519.PublicKey) {
	t.Helper()
	if proof.EnvelopeVersion != providerControlEnvelope || proof.Kind != "enrollment_proof" ||
		proof.Signature.Algorithm != relaySignatureAlgorithm || proof.Signature.KeyID != proof.Payload.DeviceKeyID {
		t.Fatalf("unexpected proof envelope: %#v", proof)
	}
	canonical, err := canonicalJSON(map[string]any{
		"envelopeVersion": providerControlEnvelope,
		"kind":            "enrollment_proof",
		"payload":         enrollmentPayloadMap(proof.Payload),
		"signature":       map[string]any{"algorithm": relaySignatureAlgorithm, "keyId": proof.Signature.KeyID},
	}, maxRelayEnvelopeBytes)
	if err != nil {
		t.Fatal(err)
	}
	signature, err := base64.RawURLEncoding.DecodeString(proof.Signature.Value)
	if err != nil || !ed25519.Verify(publicKey, append(append([]byte{}, providerControlSigningDomain...), canonical...), signature) {
		t.Fatal("Cloud enrollment proof does not verify over the provider-control domain")
	}
}

func TestCloudEnrollmentSubmitsExactConsentPersistsNoGrantAndStaysNonCommercial(t *testing.T) {
	identity, err := newMemoryDeviceIdentity()
	if err != nil {
		t.Fatal(err)
	}
	keyID, _ := identity.publicIdentity()
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	token := "mve_" + strings.Repeat("a", 43)
	nonce := base64.RawURLEncoding.EncodeToString([]byte("12345678901234567890123456789012"))
	falseValue := false
	var cloudCalls atomic.Int32
	cloud := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		cloudCalls.Add(1)
		response.Header().Set("content-type", "application/json")
		switch request.URL.Path {
		case "/provider/v1/enrollment-challenges":
			if request.Method != http.MethodPost || request.Header.Get("authorization") != "Bearer "+token ||
				!strings.HasPrefix(request.Header.Get("idempotency-key"), "challenge-") {
				t.Fatalf("unexpected challenge request: %#v", request)
			}
			var begin cloudEnrollmentChallengeRequest
			decoder := json.NewDecoder(request.Body)
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(&begin); err != nil {
				t.Fatal(err)
			}
			if begin.ClientNodeID != deterministicClientNodeID(begin.DevicePublicKeySPKI) ||
				begin.Manifest.ManifestVersion != providerManifestVersion || begin.Manifest.ProtocolVersion != providerControlProtocol ||
				begin.Manifest.CompanionVersion != providerCompanionVersion || begin.Manifest.CoreVersion != "0.2.0" ||
				begin.Manifest.RuntimeFamily != "omlx" || len(begin.Manifest.SelectedModels) != 1 ||
				begin.Manifest.SelectedModels[0].ReportedID != "publisher/model" || begin.Manifest.DeclaredMaxConcurrency != 4 {
				t.Fatalf("unexpected consent manifest: %#v", begin)
			}
			response.WriteHeader(http.StatusCreated)
			_ = json.NewEncoder(response).Encode(cloudEnrollmentChallenge{
				EnrollmentID: testEnrollmentID, ChallengeID: testChallengeID, Nonce: nonce,
				ProviderID: testProviderID, NodeID: testNodeID, DeviceKeyID: keyID,
				ManifestDigest: strings.Repeat("b", 64), DisclosureVersion: "shadow-disclosure-v1",
				IssuedAt: now.Format("2006-01-02T15:04:05.000Z"), ExpiresAt: now.Add(5 * time.Minute).Format("2006-01-02T15:04:05.000Z"),
				State: "challenge_issued", RoutingEligible: &falseValue, CompensationEligible: &falseValue,
			})
		case "/provider/v1/enrollments/" + testEnrollmentID + "/proofs":
			if request.Method != http.MethodPost || request.Header.Get("authorization") != "" ||
				!strings.HasPrefix(request.Header.Get("idempotency-key"), "proof-") {
				t.Fatalf("unexpected proof request: %#v", request)
			}
			var proof signedEnrollmentProof
			decoder := json.NewDecoder(request.Body)
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(&proof); err != nil {
				t.Fatal(err)
			}
			verifyEnrollmentProof(t, proof, identity.privateKey.Public().(ed25519.PublicKey))
			_ = json.NewEncoder(response).Encode(map[string]any{
				"providerId": testProviderID, "nodeId": testNodeID, "deviceKeyId": keyID,
				"state": "submitted", "credentialEpoch": uint64(1), "manifestDigest": strings.Repeat("b", 64),
				"routingEligible": false, "compensationEligible": false,
			})
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer cloud.Close()

	baseURL, err := cloudAPIURL(cloud.URL)
	if err != nil {
		t.Fatal(err)
	}
	statePath := filepath.Join(t.TempDir(), "provider-cloud-enrollment.json")
	store, err := openCloudEnrollmentStore(statePath)
	if err != nil {
		t.Fatal(err)
	}
	selections := newMemorySelectionStore([]string{"publisher/model"})
	service := newCloudEnrollmentService(baseURL, cloud.Client(), identity, selections, store)
	service.now = func() time.Time { return now }
	core, _ := url.Parse("http://127.0.0.1:1455")
	controlToken := strings.Repeat("c", 32)
	handler := providerHandlerWithServices(core, selections, newMemoryRuntimeEndpointStore(), identity, service, http.DefaultClient, controlToken)

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodPost, "/v1/cloud-shadow/enroll", nil))
	if unauthorized.Code != http.StatusNotFound {
		t.Fatalf("unauthorized enrollment endpoint leaked state: %d", unauthorized.Code)
	}

	request := httptest.NewRequest(http.MethodPost, "/v1/cloud-shadow/enroll", strings.NewReader(enrollmentRequestBody(token)))
	request.Header.Set("authorization", "Bearer "+controlToken)
	request.Header.Set("content-type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated || response.Header().Get("cache-control") != "no-store" {
		t.Fatalf("unexpected enrollment response: %d %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), token) || strings.Contains(response.Body.String(), "enrollment_token") ||
		strings.Contains(response.Body.String(), "private_key") || strings.Contains(response.Body.String(), "privateKey") {
		t.Fatal("provider enrollment response leaked credential material")
	}
	var view cloudEnrollmentView
	if err := json.Unmarshal(response.Body.Bytes(), &view); err != nil || view.State != "submitted" ||
		view.RoutingEligible || view.CompensationEligible || view.NodeID != testNodeID {
		t.Fatalf("unexpected enrollment view: %#v %v", view, err)
	}
	info, err := os.Stat(statePath)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("enrollment state is not mode 0600: %#v %v", info, err)
	}
	contents, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(contents), token) || strings.Contains(string(contents), "enrollment_token") {
		t.Fatal("persisted enrollment state contains the grant")
	}

	status := httptest.NewRecorder()
	statusRequest := httptest.NewRequest(http.MethodGet, "/v1/cloud-shadow/enrollment", nil)
	statusRequest.Header.Set("authorization", "Bearer "+controlToken)
	handler.ServeHTTP(status, statusRequest)
	if status.Code != http.StatusOK || !strings.Contains(status.Body.String(), `"state":"submitted"`) {
		t.Fatalf("unexpected enrollment status: %d %s", status.Code, status.Body.String())
	}
	manifestResponse := httptest.NewRecorder()
	handler.ServeHTTP(manifestResponse, httptest.NewRequest(http.MethodGet, "/v1/manifest", nil))
	if manifestResponse.Code != http.StatusOK || !strings.Contains(manifestResponse.Body.String(), `"state":"submitted"`) {
		t.Fatalf("manifest did not advance to submitted: %d %s", manifestResponse.Code, manifestResponse.Body.String())
	}
	selectionUpdate := httptest.NewRequest(http.MethodPut, "/v1/selection", strings.NewReader(`{"revision":1,"selected_models":[]}`))
	selectionUpdate.Header.Set("authorization", "Bearer "+controlToken)
	selectionUpdate.Header.Set("content-type", "application/json")
	selectionResponse := httptest.NewRecorder()
	handler.ServeHTTP(selectionResponse, selectionUpdate)
	if selectionResponse.Code != http.StatusConflict {
		t.Fatalf("submitted selection was not frozen: %d %s", selectionResponse.Code, selectionResponse.Body.String())
	}

	retry := httptest.NewRecorder()
	retryRequest := httptest.NewRequest(http.MethodPost, "/v1/cloud-shadow/enroll", strings.NewReader(enrollmentRequestBody(token)))
	retryRequest.Header.Set("authorization", "Bearer "+controlToken)
	retryRequest.Header.Set("content-type", "application/json")
	handler.ServeHTTP(retry, retryRequest)
	if retry.Code != http.StatusConflict || cloudCalls.Load() != 2 {
		t.Fatalf("reenrollment was not fenced locally: %d calls=%d", retry.Code, cloudCalls.Load())
	}
}

func TestCloudEnrollmentRejectsUnselectedModelsAndUntrustedOriginsBeforeNetwork(t *testing.T) {
	for _, raw := range []string{
		"http://api.multivibe.cloud", "https://evil.example", "http://localhost:8080", "http://192.168.1.10:8080",
		"https://user:secret@api.multivibe.cloud", "https://api.multivibe.cloud/path",
	} {
		if _, err := cloudAPIURL(raw); err == nil {
			t.Fatalf("untrusted Cloud origin accepted: %s", raw)
		}
	}
	identity, _ := newMemoryDeviceIdentity()
	baseURL, _ := cloudAPIURL("http://127.0.0.1:65534")
	selections := newMemorySelectionStore([]string{"publisher/model"})
	service := newCloudEnrollmentService(baseURL, http.DefaultClient, identity, selections, newMemoryCloudEnrollmentStore())
	input := cloudEnrollmentInput{
		EnrollmentToken: "mve_" + strings.Repeat("a", 43), CoreVersion: "0.2.0", RuntimeFamily: "omlx",
		SelectedModels:         []cloudEnrollmentModel{{ReportedID: "different/model", Modalities: []string{"text"}}},
		DeclaredMaxConcurrency: 1,
	}
	if _, err := service.enroll(context.Background(), input); !errors.Is(err, errInvalidCloudEnrollment) {
		t.Fatalf("unselected model did not fail before network: %v", err)
	}
}

func TestCloudEnrollmentStateRejectsLoosePermissionsAndUnknownFields(t *testing.T) {
	path := filepath.Join(t.TempDir(), "enrollment.json")
	if err := os.WriteFile(path, []byte(`{"schema_version":"provider-cloud-enrollment-v1","unexpected":true}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := openCloudEnrollmentStore(path); err == nil {
		t.Fatal("loose or malformed enrollment state must fail closed")
	}
}
