package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"time"
)

const (
	relayShadowProtocol            = "multivibe-provider-relay-shadow-v1"
	relayShadowEnvelope            = "multivibe-provider-relay-envelope-v1"
	relayCanonicalization          = "mv-json-v1"
	relaySignatureAlgorithm        = "Ed25519"
	maxRelaySequence        uint64 = 1<<48 - 1
	maxRelayEnvelopeBytes          = 16 * 1024
)

var relayIdentifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$`)
var relaySigningDomain = []byte("MultiVibe Provider Relay\x00multivibe-provider-relay-shadow-v1\x00signed-session-v1\x00")

type relaySessionRequest struct {
	SessionID       string `json:"session_id"`
	OrganizationID  string `json:"organization_id"`
	ProviderID      string `json:"provider_id"`
	NodeID          string `json:"node_id"`
	CredentialEpoch uint64 `json:"credential_epoch"`
	RelayID         string `json:"relay_id"`
	Region          string `json:"region"`
	Transport       string `json:"transport"`
}

type relaySessionPayload struct {
	Kind                    string `json:"kind"`
	ProtocolVersion         string `json:"protocolVersion"`
	CanonicalizationVersion string `json:"canonicalizationVersion"`
	SessionID               string `json:"sessionId"`
	OrganizationID          string `json:"organizationId"`
	ProviderID              string `json:"providerId"`
	NodeID                  string `json:"nodeId"`
	DeviceKeyID             string `json:"deviceKeyId"`
	CredentialEpoch         uint64 `json:"credentialEpoch"`
	Sequence                uint64 `json:"sequence"`
	Nonce                   string `json:"nonce"`
	RelayID                 string `json:"relayId"`
	Region                  string `json:"region"`
	Transport               string `json:"transport"`
	IssuedAt                string `json:"issuedAt"`
	ExpiresAt               string `json:"expiresAt"`
	ShadowOnly              bool   `json:"shadowOnly"`
	CustomerTrafficAllowed  bool   `json:"customerTrafficAllowed"`
	RoutingEligible         bool   `json:"routingEligible"`
	CompensationEligible    bool   `json:"compensationEligible"`
}

type relaySignature struct {
	Algorithm string `json:"algorithm"`
	KeyID     string `json:"keyId"`
	Value     string `json:"value,omitempty"`
}

type signedRelaySession struct {
	EnvelopeVersion string              `json:"envelopeVersion"`
	Kind            string              `json:"kind"`
	Payload         relaySessionPayload `json:"payload"`
	Signature       relaySignature      `json:"signature"`
}

func validateRelaySessionRequest(request relaySessionRequest) error {
	for _, value := range []string{
		request.SessionID, request.OrganizationID, request.ProviderID, request.NodeID, request.RelayID, request.Region,
	} {
		if !relayIdentifier.MatchString(value) {
			return errors.New("provider relay shadow request contains an invalid identifier")
		}
	}
	if request.CredentialEpoch < 1 || request.CredentialEpoch > maxRelaySequence {
		return errors.New("provider relay shadow credential epoch is invalid")
	}
	if request.Transport != "outbound_mtls" && request.Transport != "tailscale_private" {
		return errors.New("provider relay shadow transport is invalid")
	}
	return nil
}

func canonicalJSON(value any, maximum int) ([]byte, error) {
	var output bytes.Buffer
	var write func(any, int) error
	write = func(current any, depth int) error {
		if depth > 24 {
			return errors.New("canonical value is too deeply nested")
		}
		switch typed := current.(type) {
		case nil:
			output.WriteString("null")
		case bool:
			output.WriteString(strconv.FormatBool(typed))
		case string:
			encoded, err := json.Marshal(typed)
			if err != nil {
				return err
			}
			output.Write(encoded)
		case uint64:
			if typed > maxRelaySequence {
				return errors.New("canonical integer is outside the safe range")
			}
			output.WriteString(strconv.FormatUint(typed, 10))
		case []any:
			if len(typed) > 2048 {
				return errors.New("canonical array exceeds the item limit")
			}
			output.WriteByte('[')
			for index, child := range typed {
				if index > 0 {
					output.WriteByte(',')
				}
				if err := write(child, depth+1); err != nil {
					return err
				}
			}
			output.WriteByte(']')
		case map[string]any:
			if len(typed) > 256 {
				return errors.New("canonical object exceeds the key limit")
			}
			keys := make([]string, 0, len(typed))
			for key := range typed {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			output.WriteByte('{')
			for index, key := range keys {
				if index > 0 {
					output.WriteByte(',')
				}
				encoded, err := json.Marshal(key)
				if err != nil {
					return err
				}
				output.Write(encoded)
				output.WriteByte(':')
				if err := write(typed[key], depth+1); err != nil {
					return err
				}
			}
			output.WriteByte('}')
		default:
			return fmt.Errorf("unsupported canonical value %T", current)
		}
		if output.Len() > maximum {
			return errors.New("canonical provider relay envelope is too large")
		}
		return nil
	}
	if err := write(value, 0); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func relayPayloadMap(payload relaySessionPayload) map[string]any {
	return map[string]any{
		"kind": payload.Kind, "protocolVersion": payload.ProtocolVersion,
		"canonicalizationVersion": payload.CanonicalizationVersion, "sessionId": payload.SessionID,
		"organizationId": payload.OrganizationID, "providerId": payload.ProviderID, "nodeId": payload.NodeID,
		"deviceKeyId": payload.DeviceKeyID, "credentialEpoch": payload.CredentialEpoch, "sequence": payload.Sequence,
		"nonce": payload.Nonce, "relayId": payload.RelayID, "region": payload.Region, "transport": payload.Transport,
		"issuedAt": payload.IssuedAt, "expiresAt": payload.ExpiresAt, "shadowOnly": payload.ShadowOnly,
		"customerTrafficAllowed": payload.CustomerTrafficAllowed, "routingEligible": payload.RoutingEligible,
		"compensationEligible": payload.CompensationEligible,
	}
}

func unsignedRelayMap(payload relaySessionPayload, keyID string) map[string]any {
	return map[string]any{
		"envelopeVersion": relayShadowEnvelope,
		"kind":            "relay_session_open",
		"payload":         relayPayloadMap(payload),
		"signature":       map[string]any{"algorithm": relaySignatureAlgorithm, "keyId": keyID},
	}
}

func (identity *deviceIdentity) signRelaySession(request relaySessionRequest, now time.Time) (signedRelaySession, error) {
	if err := validateRelaySessionRequest(request); err != nil {
		return signedRelaySession{}, err
	}
	identity.mu.Lock()
	defer identity.mu.Unlock()
	if identity.sequence >= maxRelaySequence {
		return signedRelaySession{}, errors.New("provider relay shadow sequence is exhausted")
	}
	identity.sequence++
	if identity.path != "" {
		if err := identity.persistLocked(); err != nil {
			identity.sequence--
			return signedRelaySession{}, err
		}
	}
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		return signedRelaySession{}, errors.New("provider relay shadow nonce cannot be generated")
	}
	issued := now.UTC().Truncate(time.Millisecond)
	payload := relaySessionPayload{
		Kind: "relay_session_open", ProtocolVersion: relayShadowProtocol, CanonicalizationVersion: relayCanonicalization,
		SessionID: request.SessionID, OrganizationID: request.OrganizationID, ProviderID: request.ProviderID,
		NodeID: request.NodeID, DeviceKeyID: identity.deviceKeyID, CredentialEpoch: request.CredentialEpoch,
		Sequence: identity.sequence, Nonce: base64.RawURLEncoding.EncodeToString(nonce), RelayID: request.RelayID,
		Region: request.Region, Transport: request.Transport,
		IssuedAt: issued.Format("2006-01-02T15:04:05.000Z"), ExpiresAt: issued.Add(30 * time.Second).Format("2006-01-02T15:04:05.000Z"),
		ShadowOnly: true, CustomerTrafficAllowed: false, RoutingEligible: false, CompensationEligible: false,
	}
	canonical, err := canonicalJSON(unsignedRelayMap(payload, identity.deviceKeyID), maxRelayEnvelopeBytes)
	if err != nil {
		return signedRelaySession{}, err
	}
	signedBytes := append(append([]byte{}, relaySigningDomain...), canonical...)
	signature := ed25519.Sign(identity.privateKey, signedBytes)
	return signedRelaySession{
		EnvelopeVersion: relayShadowEnvelope, Kind: "relay_session_open", Payload: payload,
		Signature: relaySignature{Algorithm: relaySignatureAlgorithm, KeyID: identity.deviceKeyID, Value: base64.RawURLEncoding.EncodeToString(signature)},
	}, nil
}
