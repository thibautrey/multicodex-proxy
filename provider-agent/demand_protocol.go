package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"time"
)

const (
	providerDemandProtocol           = "multivibe-provider-demand-shadow-v1"
	providerDemandEnvelopeVersion    = "multivibe-provider-demand-envelope-v1"
	providerDemandCanonicalization   = "mv-json-v1"
	providerDemandPrivacyPolicy      = "privacy-thresholded-aggregate-v1"
	providerDemandSignatureAlgorithm = "Ed25519"
	providerDemandRuntime            = "ollama"
	providerDemandRuntimeVersion     = "v1"
	maximumProviderDemandItems       = 64
	maximumProviderDemandBytes       = 64 * 1024
	maximumProviderDemandKeys        = 64
	maximumProviderArtifactBytes     = uint64(32 * 1024 * 1024 * 1024 * 1024)
	maximumProviderVRAMBytes         = uint64(4 * 1024 * 1024 * 1024 * 1024)
)

var (
	providerDemandSigningDomain = []byte("MultiVibe Provider Demand\x00multivibe-provider-demand-shadow-v1\x00signed-envelope-v1\x00")
	providerDemandDigestDomain  = []byte("MultiVibe Provider Demand\x00multivibe-provider-demand-shadow-v1\x00signed-envelope-digest-v1\x00")
	providerDemandModelID       = regexp.MustCompile(`^(hf|openrouter):[a-z0-9][a-z0-9._-]{0,63}/[a-z0-9][a-z0-9._-]{0,127}(/[a-z0-9][a-z0-9._-]{0,127})*$`)
	providerDemandLicenseID     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$`)
	providerDemandContentDigest = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)
	providerDemandKeyID         = regexp.MustCompile(`^ed25519:[A-Za-z0-9_-]{43}$`)
	errInvalidProviderDemand    = errors.New("provider demand envelope is invalid")
)

type providerDemandAggregate struct {
	CanonicalModelID     string `json:"canonicalModelId"`
	RequiredContext      uint64 `json:"requiredContextTokens"`
	DemandScoreBucket    string `json:"demandScoreBucket"`
	RequestBucket        string `json:"requestBucket"`
	MaxUsefulConcurrency uint64 `json:"maxUsefulConcurrency"`
}

type providerDemandVRAMEstimate struct {
	ContextTokens      uint64 `json:"contextTokens"`
	EstimatedVRAMBytes uint64 `json:"estimatedVramBytes"`
}

type providerDemandLicense struct {
	LicenseID              string `json:"licenseId"`
	Status                 string `json:"status"`
	HostedInferenceAllowed bool   `json:"hostedInferenceAllowed"`
	AssessmentDigest       string `json:"assessmentDigest"`
}

type providerDemandArtifact struct {
	CanonicalModelID string                       `json:"canonicalModelId"`
	Runtime          string                       `json:"runtime"`
	RuntimeVersion   string                       `json:"runtimeVersion"`
	ContentDigest    string                       `json:"contentDigest"`
	DownloadBytes    uint64                       `json:"downloadBytes"`
	VRAMEstimates    []providerDemandVRAMEstimate `json:"vramEstimates"`
	License          providerDemandLicense        `json:"license"`
}

type providerDemandSnapshot struct {
	Kind                    string                    `json:"kind"`
	ProtocolVersion         string                    `json:"protocolVersion"`
	CanonicalizationVersion string                    `json:"canonicalizationVersion"`
	PrivacyPolicyVersion    string                    `json:"privacyPolicyVersion"`
	Generation              uint64                    `json:"generation"`
	ObservedAt              string                    `json:"observedAt"`
	IssuedAt                string                    `json:"issuedAt"`
	ExpiresAt               string                    `json:"expiresAt"`
	Demands                 []providerDemandAggregate `json:"demands"`
	Artifacts               []providerDemandArtifact  `json:"artifacts"`
}

type providerDemandSignature struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"keyId"`
	Value     string `json:"value"`
}

type signedProviderDemandEnvelope struct {
	EnvelopeVersion string                  `json:"envelopeVersion"`
	Kind            string                  `json:"kind"`
	Payload         providerDemandSnapshot  `json:"payload"`
	Signature       providerDemandSignature `json:"signature"`
}

type verifiedProviderDemand struct {
	Payload        providerDemandSnapshot
	SigningKeyID   string
	EnvelopeDigest string
}

type trustedProviderDemandKeys map[string]ed25519.PublicKey

func validateUniqueJSONKeys(raw []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	nodes := 0
	var value func(int) error
	value = func(depth int) error {
		if depth > 24 {
			return errInvalidProviderDemand
		}
		nodes++
		if nodes > 8192 {
			return errInvalidProviderDemand
		}
		token, err := decoder.Token()
		if err != nil {
			return errInvalidProviderDemand
		}
		delimiter, compound := token.(json.Delim)
		if !compound {
			return nil
		}
		switch delimiter {
		case '{':
			seen := make(map[string]struct{})
			for decoder.More() {
				keyToken, err := decoder.Token()
				key, ok := keyToken.(string)
				if err != nil || !ok {
					return errInvalidProviderDemand
				}
				if _, exists := seen[key]; exists {
					return errInvalidProviderDemand
				}
				seen[key] = struct{}{}
				if err := value(depth + 1); err != nil {
					return err
				}
			}
			closing, err := decoder.Token()
			if err != nil || closing != json.Delim('}') {
				return errInvalidProviderDemand
			}
		case '[':
			for decoder.More() {
				if err := value(depth + 1); err != nil {
					return err
				}
			}
			closing, err := decoder.Token()
			if err != nil || closing != json.Delim(']') {
				return errInvalidProviderDemand
			}
		default:
			return errInvalidProviderDemand
		}
		return nil
	}
	if err := value(0); err != nil {
		return err
	}
	return ensureJSONEOF(decoder)
}

func parseTrustedProviderDemandKeys(raw string) (trustedProviderDemandKeys, error) {
	if len(raw) == 0 || len(raw) > maximumProviderDemandBytes || validateUniqueJSONKeys([]byte(raw)) != nil {
		return nil, errors.New("trusted provider demand keys are invalid")
	}
	var encoded map[string]string
	decoder := json.NewDecoder(bytes.NewReader([]byte(raw)))
	if decoder.Decode(&encoded) != nil || ensureJSONEOF(decoder) != nil || len(encoded) < 1 || len(encoded) > maximumProviderDemandKeys {
		return nil, errors.New("trusted provider demand keys are invalid")
	}
	keys := make(trustedProviderDemandKeys, len(encoded))
	for declaredID, encodedSPKI := range encoded {
		der, err := base64.StdEncoding.DecodeString(encodedSPKI)
		if err != nil || base64.StdEncoding.EncodeToString(der) != encodedSPKI || len(der) > 256 {
			return nil, errors.New("trusted provider demand keys are invalid")
		}
		parsed, err := x509.ParsePKIXPublicKey(der)
		publicKey, ok := parsed.(ed25519.PublicKey)
		if err != nil || !ok || len(publicKey) != ed25519.PublicKeySize || demandPublicKeyID(der) != declaredID {
			return nil, errors.New("trusted provider demand keys are invalid")
		}
		keys[declaredID] = append(ed25519.PublicKey(nil), publicKey...)
	}
	return keys, nil
}

func demandPublicKeyID(spki []byte) string {
	digest := sha256.Sum256(spki)
	return "ed25519:" + base64.RawURLEncoding.EncodeToString(digest[:])
}

func validDemandContextBucket(value uint64) bool {
	for _, allowed := range []uint64{2048, 4096, 8192, 16384, 32768, 65536, 131072} {
		if value == allowed {
			return true
		}
	}
	return false
}

func validDemandBucket(value string) bool {
	return value == "low" || value == "medium" || value == "high" || value == "very_high"
}

func validRequestBucket(value string) bool {
	return value == "threshold" || value == "steady" || value == "busy" || value == "surge"
}

func validateProviderDemandSnapshot(snapshot providerDemandSnapshot, now time.Time) error {
	if snapshot.Kind != "provider_demand_snapshot" || snapshot.ProtocolVersion != providerDemandProtocol ||
		snapshot.CanonicalizationVersion != providerDemandCanonicalization || snapshot.PrivacyPolicyVersion != providerDemandPrivacyPolicy ||
		snapshot.Generation < 1 || snapshot.Generation > maxRelaySequence || snapshot.Demands == nil || snapshot.Artifacts == nil ||
		len(snapshot.Demands) > maximumProviderDemandItems || len(snapshot.Demands) != len(snapshot.Artifacts) {
		return errInvalidProviderDemand
	}
	observedAt, observedErr := canonicalTimestamp(snapshot.ObservedAt)
	issuedAt, issuedErr := canonicalTimestamp(snapshot.IssuedAt)
	expiresAt, expiresErr := canonicalTimestamp(snapshot.ExpiresAt)
	if observedErr != nil || issuedErr != nil || expiresErr != nil || observedAt.After(issuedAt) || issuedAt.Sub(observedAt) > time.Minute ||
		issuedAt.After(now.Add(30*time.Second)) || now.Sub(observedAt) > 5*time.Minute || !expiresAt.After(issuedAt) ||
		expiresAt.Sub(issuedAt) > 2*time.Minute || !now.Before(expiresAt) {
		return errInvalidProviderDemand
	}
	previous := ""
	for index, demand := range snapshot.Demands {
		artifact := snapshot.Artifacts[index]
		if !providerDemandModelID.MatchString(demand.CanonicalModelID) || demand.CanonicalModelID <= previous ||
			demand.CanonicalModelID != artifact.CanonicalModelID || !validDemandContextBucket(demand.RequiredContext) ||
			!validDemandBucket(demand.DemandScoreBucket) || !validRequestBucket(demand.RequestBucket) ||
			demand.MaxUsefulConcurrency < 1 || demand.MaxUsefulConcurrency > 1000 {
			return errInvalidProviderDemand
		}
		previous = demand.CanonicalModelID
		if artifact.Runtime != providerDemandRuntime || artifact.RuntimeVersion != providerDemandRuntimeVersion ||
			!providerDemandContentDigest.MatchString(artifact.ContentDigest) || artifact.DownloadBytes < 1 ||
			artifact.DownloadBytes > maximumProviderArtifactBytes || len(artifact.VRAMEstimates) < 1 || len(artifact.VRAMEstimates) > 7 ||
			!providerDemandLicenseID.MatchString(artifact.License.LicenseID) || artifact.License.Status != "approved" ||
			!artifact.License.HostedInferenceAllowed || !providerDigest.MatchString(artifact.License.AssessmentDigest) {
			return errInvalidProviderDemand
		}
		previousContext := uint64(0)
		hasRequiredEstimate := false
		for _, estimate := range artifact.VRAMEstimates {
			if !validDemandContextBucket(estimate.ContextTokens) || estimate.ContextTokens <= previousContext ||
				estimate.EstimatedVRAMBytes < 1 || estimate.EstimatedVRAMBytes > maximumProviderVRAMBytes {
				return errInvalidProviderDemand
			}
			previousContext = estimate.ContextTokens
			if estimate.ContextTokens == demand.RequiredContext {
				hasRequiredEstimate = true
			}
		}
		if !hasRequiredEstimate {
			return errInvalidProviderDemand
		}
	}
	return nil
}

func providerDemandPayloadMap(payload providerDemandSnapshot) map[string]any {
	demands := make([]any, 0, len(payload.Demands))
	for _, demand := range payload.Demands {
		demands = append(demands, map[string]any{
			"canonicalModelId": demand.CanonicalModelID, "requiredContextTokens": demand.RequiredContext,
			"demandScoreBucket": demand.DemandScoreBucket, "requestBucket": demand.RequestBucket,
			"maxUsefulConcurrency": demand.MaxUsefulConcurrency,
		})
	}
	artifacts := make([]any, 0, len(payload.Artifacts))
	for _, artifact := range payload.Artifacts {
		estimates := make([]any, 0, len(artifact.VRAMEstimates))
		for _, estimate := range artifact.VRAMEstimates {
			estimates = append(estimates, map[string]any{
				"contextTokens": estimate.ContextTokens, "estimatedVramBytes": estimate.EstimatedVRAMBytes,
			})
		}
		artifacts = append(artifacts, map[string]any{
			"canonicalModelId": artifact.CanonicalModelID, "runtime": artifact.Runtime,
			"runtimeVersion": artifact.RuntimeVersion, "contentDigest": artifact.ContentDigest,
			"downloadBytes": artifact.DownloadBytes, "vramEstimates": estimates,
			"license": map[string]any{
				"licenseId": artifact.License.LicenseID, "status": artifact.License.Status,
				"hostedInferenceAllowed": artifact.License.HostedInferenceAllowed,
				"assessmentDigest":       artifact.License.AssessmentDigest,
			},
		})
	}
	return map[string]any{
		"kind": payload.Kind, "protocolVersion": payload.ProtocolVersion,
		"canonicalizationVersion": payload.CanonicalizationVersion, "privacyPolicyVersion": payload.PrivacyPolicyVersion,
		"generation": payload.Generation, "observedAt": payload.ObservedAt, "issuedAt": payload.IssuedAt,
		"expiresAt": payload.ExpiresAt, "demands": demands, "artifacts": artifacts,
	}
}

func unsignedProviderDemandMap(envelope signedProviderDemandEnvelope) map[string]any {
	return map[string]any{
		"envelopeVersion": envelope.EnvelopeVersion, "kind": envelope.Kind,
		"payload":   providerDemandPayloadMap(envelope.Payload),
		"signature": map[string]any{"algorithm": envelope.Signature.Algorithm, "keyId": envelope.Signature.KeyID},
	}
}

func signedProviderDemandMap(envelope signedProviderDemandEnvelope) map[string]any {
	value := unsignedProviderDemandMap(envelope)
	value["signature"] = map[string]any{
		"algorithm": envelope.Signature.Algorithm, "keyId": envelope.Signature.KeyID, "value": envelope.Signature.Value,
	}
	return value
}

func verifySignedProviderDemand(raw []byte, trusted trustedProviderDemandKeys, now time.Time) (verifiedProviderDemand, error) {
	if len(raw) < 1 || len(raw) > maximumProviderDemandBytes || len(trusted) < 1 || len(trusted) > maximumProviderDemandKeys ||
		validateUniqueJSONKeys(raw) != nil {
		return verifiedProviderDemand{}, errInvalidProviderDemand
	}
	var envelope signedProviderDemandEnvelope
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&envelope) != nil || ensureJSONEOF(decoder) != nil || envelope.EnvelopeVersion != providerDemandEnvelopeVersion ||
		envelope.Kind != "provider_demand_snapshot" || envelope.Kind != envelope.Payload.Kind ||
		envelope.Signature.Algorithm != providerDemandSignatureAlgorithm || !providerDemandKeyID.MatchString(envelope.Signature.KeyID) ||
		validateProviderDemandSnapshot(envelope.Payload, now) != nil {
		return verifiedProviderDemand{}, errInvalidProviderDemand
	}
	publicKey, exists := trusted[envelope.Signature.KeyID]
	if !exists || len(publicKey) != ed25519.PublicKeySize {
		return verifiedProviderDemand{}, errInvalidProviderDemand
	}
	signature, err := base64.RawURLEncoding.DecodeString(envelope.Signature.Value)
	if err != nil || len(signature) != ed25519.SignatureSize || base64.RawURLEncoding.EncodeToString(signature) != envelope.Signature.Value {
		return verifiedProviderDemand{}, errInvalidProviderDemand
	}
	unsigned, err := canonicalJSON(unsignedProviderDemandMap(envelope), maximumProviderDemandBytes)
	if err != nil || !ed25519.Verify(publicKey, append(append([]byte{}, providerDemandSigningDomain...), unsigned...), signature) {
		return verifiedProviderDemand{}, errInvalidProviderDemand
	}
	signed, err := canonicalJSON(signedProviderDemandMap(envelope), maximumProviderDemandBytes)
	if err != nil {
		return verifiedProviderDemand{}, errInvalidProviderDemand
	}
	digest := sha256.New()
	_, _ = digest.Write(providerDemandDigestDomain)
	_, _ = digest.Write(signed)
	return verifiedProviderDemand{
		Payload: envelope.Payload, SigningKeyID: envelope.Signature.KeyID, EnvelopeDigest: hex.EncodeToString(digest.Sum(nil)),
	}, nil
}

func providerDemandToPlanner(verified verifiedProviderDemand) (authoritativeDemandSnapshot, []providerDemandArtifact, error) {
	scoreWeight := map[string]uint64{"low": 1, "medium": 4, "high": 16, "very_high": 64}
	requestWeight := map[string]uint64{"threshold": 1, "steady": 2, "busy": 4, "surge": 8}
	issuedAt, issuedErr := canonicalTimestamp(verified.Payload.IssuedAt)
	expiresAt, expiresErr := canonicalTimestamp(verified.Payload.ExpiresAt)
	if issuedErr != nil || expiresErr != nil {
		return authoritativeDemandSnapshot{}, nil, errInvalidProviderDemand
	}
	models := make([]authoritativeModelDemand, 0, len(verified.Payload.Demands))
	for _, demand := range verified.Payload.Demands {
		units, ok := checkedMultiply(scoreWeight[demand.DemandScoreBucket], requestWeight[demand.RequestBucket])
		if !ok {
			return authoritativeDemandSnapshot{}, nil, errInvalidProviderDemand
		}
		units, ok = checkedMultiply(units, demand.MaxUsefulConcurrency)
		if !ok || units == 0 {
			return authoritativeDemandSnapshot{}, nil, errInvalidProviderDemand
		}
		models = append(models, authoritativeModelDemand{
			ModelID: demand.CanonicalModelID, DemandUnits: units, RequiredContextTokens: demand.RequiredContext,
		})
	}
	artifacts := append([]providerDemandArtifact(nil), verified.Payload.Artifacts...)
	sort.Slice(artifacts, func(left, right int) bool {
		return artifacts[left].CanonicalModelID < artifacts[right].CanonicalModelID
	})
	return authoritativeDemandSnapshot{
		SchemaVersion: authoritativeDemandSchemaVersion, AuthorityKeyID: verified.SigningKeyID,
		Revision: verified.Payload.Generation, IssuedAt: issuedAt, ExpiresAt: expiresAt, Models: models,
	}, artifacts, nil
}

func trustedProviderDemandKeysJSON(keys trustedProviderDemandKeys) (string, error) {
	encoded := make(map[string]string, len(keys))
	for keyID, publicKey := range keys {
		der, err := x509.MarshalPKIXPublicKey(publicKey)
		if err != nil || demandPublicKeyID(der) != keyID {
			return "", fmt.Errorf("trusted provider demand key cannot be encoded")
		}
		encoded[keyID] = base64.StdEncoding.EncodeToString(der)
	}
	raw, err := json.Marshal(encoded)
	return string(raw), err
}
