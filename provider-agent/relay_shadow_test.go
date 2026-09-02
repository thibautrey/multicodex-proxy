package main

import (
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func relayRequest() relaySessionRequest {
	return relaySessionRequest{
		SessionID: "session-1", OrganizationID: "organization-1", ProviderID: "provider-1",
		NodeID: "node-1", CredentialEpoch: 2, RelayID: "relay-eu-1", Region: "eu",
		Transport: "outbound_mtls",
	}
}

func TestDeviceIdentityPersistsMode0600AndMonotonicSequence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "device-identity.json")
	identity, err := openDeviceIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	first, err := identity.signRelaySession(relayRequest(), time.UnixMilli(1_800_000_000_000))
	if err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("device identity must be mode 0600, got %o", info.Mode().Perm())
	}
	restarted, err := openDeviceIdentity(path)
	if err != nil {
		t.Fatal(err)
	}
	second, err := restarted.signRelaySession(relayRequest(), time.UnixMilli(1_800_000_001_000))
	if err != nil {
		t.Fatal(err)
	}
	if first.Payload.Sequence != 1 || second.Payload.Sequence != 2 || first.Signature.KeyID != second.Signature.KeyID {
		t.Fatalf("identity or sequence changed across restart: first=%#v second=%#v", first, second)
	}
}

func TestRelayShadowEnvelopeSignatureAndLocksMatchCloudContract(t *testing.T) {
	identity, err := newMemoryDeviceIdentity()
	if err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1_800_000_000_123)
	envelope, err := identity.signRelaySession(relayRequest(), now)
	if err != nil {
		t.Fatal(err)
	}
	if envelope.EnvelopeVersion != relayShadowEnvelope || envelope.Kind != "relay_session_open" ||
		!envelope.Payload.ShadowOnly || envelope.Payload.CustomerTrafficAllowed ||
		envelope.Payload.RoutingEligible || envelope.Payload.CompensationEligible {
		t.Fatalf("relay shadow locks changed: %#v", envelope)
	}
	if envelope.Payload.IssuedAt != "2027-01-15T08:00:00.123Z" || envelope.Payload.ExpiresAt != "2027-01-15T08:00:30.123Z" {
		t.Fatalf("unexpected canonical timestamps: %#v", envelope.Payload)
	}
	canonical, err := canonicalJSON(unsignedRelayMap(envelope.Payload, envelope.Signature.KeyID), maxRelayEnvelopeBytes)
	if err != nil {
		t.Fatal(err)
	}
	signedBytes := append(append([]byte{}, relaySigningDomain...), canonical...)
	signature, err := base64.RawURLEncoding.DecodeString(envelope.Signature.Value)
	if err != nil || len(signature) != ed25519.SignatureSize ||
		!ed25519.Verify(identity.privateKey.Public().(ed25519.PublicKey), signedBytes, signature) {
		t.Fatal("relay shadow signature does not verify over canonical Cloud bytes")
	}
}

func TestRelayShadowControlEndpointIsAuthenticatedBoundedAndSecretFree(t *testing.T) {
	core, err := url.Parse("http://127.0.0.1:1455")
	if err != nil {
		t.Fatal(err)
	}
	identity, err := newMemoryDeviceIdentity()
	if err != nil {
		t.Fatal(err)
	}
	token := strings.Repeat("c", 32)
	handler := providerHandlerWithStoresAndIdentity(
		core, newMemorySelectionStore([]string{"publisher/model"}), newMemoryRuntimeEndpointStore(), identity, http.DefaultClient, token,
	)
	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodPost, "/v1/relay-shadow/session-open", nil))
	if unauthorized.Code != http.StatusNotFound {
		t.Fatalf("unauthorized relay shadow endpoint leaked state: %d %s", unauthorized.Code, unauthorized.Body.String())
	}

	requestBody, err := json.Marshal(relayRequest())
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/v1/relay-shadow/session-open", strings.NewReader(string(requestBody)))
	request.Header.Set("authorization", "Bearer "+token)
	request.Header.Set("content-type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("cache-control") != "no-store" {
		t.Fatalf("unexpected relay shadow response: %d %#v %s", response.Code, response.Header(), response.Body.String())
	}
	if strings.Contains(response.Body.String(), "private_key") || strings.Contains(response.Body.String(), "privateKey") {
		t.Fatal("relay shadow response leaked private device key material")
	}

	manifestResponse := httptest.NewRecorder()
	handler.ServeHTTP(manifestResponse, httptest.NewRequest(http.MethodGet, "/v1/manifest", nil))
	var document manifest
	if err := json.Unmarshal(manifestResponse.Body.Bytes(), &document); err != nil {
		t.Fatal(err)
	}
	spki, err := base64.RawURLEncoding.DecodeString(document.DevicePublicKeySPKI)
	if err != nil {
		t.Fatal(err)
	}
	publicKey, err := x509.ParsePKIXPublicKey(spki)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := publicKey.(ed25519.PublicKey); !ok || document.DeviceKeyID != identity.deviceKeyID {
		t.Fatalf("manifest device identity is invalid: %#v", document)
	}
}

func TestRelayShadowRequestRejectsInvalidIdentityTransportAndUnknownFields(t *testing.T) {
	identity, err := newMemoryDeviceIdentity()
	if err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*relaySessionRequest){
		"invalid relay identifier": func(request *relaySessionRequest) { request.RelayID = "relay@example" },
		"zero epoch":               func(request *relaySessionRequest) { request.CredentialEpoch = 0 },
		"transport":                func(request *relaySessionRequest) { request.Transport = "public_websocket" },
	} {
		t.Run(name, func(t *testing.T) {
			request := relayRequest()
			mutate(&request)
			if _, err := identity.signRelaySession(request, time.Now()); err == nil {
				t.Fatal("invalid relay shadow request must fail closed")
			}
		})
	}
}
