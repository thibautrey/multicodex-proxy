package main

import (
	"bytes"
	"encoding/base64"
	"testing"
	"time"
)

const demandInteropSPKI = "MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo="
const demandInteropKeyID = "ed25519:BuP9j9opu2CrWVV95h7bCuzbIxE0vjDnW0Vfjht5L6k"
const demandInteropSignature = "s6Y1vg09aZms_dQSSmWpYj0OYQCjxInvQWVTtGsGknMVQdSriGbZrv42wPcNS9fSV3lj7Dig4CJjquexnqPdBg"
const demandInteropUnsigned = "eyJlbnZlbG9wZVZlcnNpb24iOiJtdWx0aXZpYmUtcHJvdmlkZXItZGVtYW5kLWVudmVsb3BlLXYxIiwia2luZCI6InByb3ZpZGVyX2RlbWFuZF9zbmFwc2hvdCIsInBheWxvYWQiOnsiYXJ0aWZhY3RzIjpbeyJjYW5vbmljYWxNb2RlbElkIjoiaGY6cHVibGlzaGVyL21vZGVsIiwiY29udGVudERpZ2VzdCI6InNoYTI1NjphYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhIiwiZG93bmxvYWRCeXRlcyI6NDAwMDAwMDAwMCwibGljZW5zZSI6eyJhc3Nlc3NtZW50RGlnZXN0IjoiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYiIsImhvc3RlZEluZmVyZW5jZUFsbG93ZWQiOnRydWUsImxpY2Vuc2VJZCI6IkFwYWNoZS0yLjAiLCJzdGF0dXMiOiJhcHByb3ZlZCJ9LCJydW50aW1lIjoib2xsYW1hIiwicnVudGltZVZlcnNpb24iOiJ2MSIsInZyYW1Fc3RpbWF0ZXMiOlt7ImNvbnRleHRUb2tlbnMiOjgxOTIsImVzdGltYXRlZFZyYW1CeXRlcyI6NTAwMDAwMDAwMH0seyJjb250ZXh0VG9rZW5zIjoxNjM4NCwiZXN0aW1hdGVkVnJhbUJ5dGVzIjo2MDAwMDAwMDAwfV19XSwiY2Fub25pY2FsaXphdGlvblZlcnNpb24iOiJtdi1qc29uLXYxIiwiZGVtYW5kcyI6W3siY2Fub25pY2FsTW9kZWxJZCI6ImhmOnB1Ymxpc2hlci9tb2RlbCIsImRlbWFuZFNjb3JlQnVja2V0IjoiaGlnaCIsIm1heFVzZWZ1bENvbmN1cnJlbmN5Ijo4LCJyZXF1ZXN0QnVja2V0IjoiYnVzeSIsInJlcXVpcmVkQ29udGV4dFRva2VucyI6ODE5Mn1dLCJleHBpcmVzQXQiOiIyMDIwLTAxLTAyVDEyOjAxOjAwLjAwMFoiLCJnZW5lcmF0aW9uIjoxLCJpc3N1ZWRBdCI6IjIwMjAtMDEtMDJUMTI6MDA6MDAuMDAwWiIsImtpbmQiOiJwcm92aWRlcl9kZW1hbmRfc25hcHNob3QiLCJvYnNlcnZlZEF0IjoiMjAyMC0wMS0wMlQxMTo1OTozMC4wMDBaIiwicHJpdmFjeVBvbGljeVZlcnNpb24iOiJwcml2YWN5LXRocmVzaG9sZGVkLWFnZ3JlZ2F0ZS12MSIsInByb3RvY29sVmVyc2lvbiI6Im11bHRpdmliZS1wcm92aWRlci1kZW1hbmQtc2hhZG93LXYxIn0sInNpZ25hdHVyZSI6eyJhbGdvcml0aG0iOiJFZDI1NTE5Iiwia2V5SWQiOiJlZDI1NTE5OkJ1UDlqOW9wdTJDcldWVjk1aDdiQ3V6Ykl4RTB2akRuVzBWZmpodDVMNmsifX0"

func demandInteropEnvelope() signedProviderDemandEnvelope {
	return signedProviderDemandEnvelope{
		EnvelopeVersion: providerDemandEnvelopeVersion,
		Kind:            "provider_demand_snapshot",
		Payload: providerDemandSnapshot{
			Kind: "provider_demand_snapshot", ProtocolVersion: providerDemandProtocol,
			CanonicalizationVersion: providerDemandCanonicalization, PrivacyPolicyVersion: providerDemandPrivacyPolicy,
			Generation: 1, ObservedAt: "2020-01-02T11:59:30.000Z", IssuedAt: "2020-01-02T12:00:00.000Z",
			ExpiresAt: "2020-01-02T12:01:00.000Z",
			Demands:   []providerDemandAggregate{{CanonicalModelID: "hf:publisher/model", RequiredContext: 8192, DemandScoreBucket: "high", RequestBucket: "busy", MaxUsefulConcurrency: 8}},
			Artifacts: []providerDemandArtifact{{
				CanonicalModelID: "hf:publisher/model", Runtime: "ollama", RuntimeVersion: "v1",
				ContentDigest: "sha256:" + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", DownloadBytes: 4_000_000_000,
				VRAMEstimates: []providerDemandVRAMEstimate{{ContextTokens: 8192, EstimatedVRAMBytes: 5_000_000_000}, {ContextTokens: 16384, EstimatedVRAMBytes: 6_000_000_000}},
				License:       providerDemandLicense{LicenseID: "Apache-2.0", Status: "approved", HostedInferenceAllowed: true, AssessmentDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
			}},
		},
		Signature: providerDemandSignature{Algorithm: "Ed25519", KeyID: demandInteropKeyID, Value: demandInteropSignature},
	}
}

func demandInteropRaw(t *testing.T) ([]byte, trustedProviderDemandKeys) {
	t.Helper()
	spki, err := base64.StdEncoding.DecodeString(demandInteropSPKI)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := parseTrustedProviderDemandKeys(`{"` + demandInteropKeyID + `":"` + demandInteropSPKI + `"}`)
	if err != nil {
		t.Fatal(err)
	}
	envelope := demandInteropEnvelope()
	raw, err := canonicalJSON(signedProviderDemandMap(envelope), maximumProviderDemandBytes)
	if err != nil || demandPublicKeyID(spki) != demandInteropKeyID {
		t.Fatalf("invalid fixture: %v", err)
	}
	return raw, keys
}

func TestProviderDemandMatchesCloudInteropVector(t *testing.T) {
	raw, keys := demandInteropRaw(t)
	verified, err := verifySignedProviderDemand(raw, keys, time.Date(2020, 1, 2, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	if verified.SigningKeyID != demandInteropKeyID || verified.EnvelopeDigest != "c1ea9b5bd4d80d8e9561e687f5ec36582726b1781268ccef5b29e8a2dcd8e450" {
		t.Fatalf("unexpected verified demand: %#v", verified)
	}
	unsigned, err := canonicalJSON(unsignedProviderDemandMap(demandInteropEnvelope()), maximumProviderDemandBytes)
	wantUnsigned, decodeErr := base64.RawURLEncoding.DecodeString(demandInteropUnsigned)
	if err != nil || decodeErr != nil || string(unsigned) != string(wantUnsigned) {
		t.Fatalf("canonical unsigned demand differs from Cloud vector: %v %v", err, decodeErr)
	}
	planner, artifacts, err := providerDemandToPlanner(verified)
	if err != nil || planner.Revision != 1 || planner.Models[0].DemandUnits != 512 || len(artifacts) != 1 {
		t.Fatalf("unexpected planner projection: %#v %#v %v", planner, artifacts, err)
	}
}

func TestProviderDemandRejectsTamperingDuplicatesAndStaleness(t *testing.T) {
	raw, keys := demandInteropRaw(t)
	now := time.Date(2020, 1, 2, 12, 0, 0, 0, time.UTC)
	for name, candidate := range map[string][]byte{
		"signature": bytes.Replace(append([]byte(nil), raw...), []byte(demandInteropSignature), []byte("A"+demandInteropSignature[1:]), 1),
		"unknown":   bytes.Replace(append([]byte(nil), raw...), []byte(`"generation":1`), []byte(`"extra":false,"generation":1`), 1),
		"duplicate": bytes.Replace(append([]byte(nil), raw...), []byte(`"generation":1`), []byte(`"generation":1,"generation":1`), 1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := verifySignedProviderDemand(candidate, keys, now); err == nil {
				t.Fatal("tampered demand was accepted")
			}
		})
	}
	if _, err := verifySignedProviderDemand(raw, keys, now.Add(2*time.Minute)); err == nil {
		t.Fatal("expired demand was accepted")
	}
}
