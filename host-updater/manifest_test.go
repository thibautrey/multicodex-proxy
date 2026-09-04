package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

func signedFixture(t *testing.T, document updateDocument) []byte {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(public)
	keyID := fmt.Sprintf("%x", digest[:8])
	previous := trustedUpdateKeys
	trustedUpdateKeys = map[string]string{keyID: base64.StdEncoding.EncodeToString(public)}
	t.Cleanup(func() { trustedUpdateKeys = previous })
	signed, _ := json.Marshal(document)
	envelope, _ := json.Marshal(updateEnvelope{
		Signed:     base64.RawURLEncoding.EncodeToString(signed),
		Signatures: []updateSignature{{KeyID: keyID, Algorithm: "ed25519", Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, signed))}},
	})
	return envelope
}

func validDocument(now time.Time) updateDocument {
	archive := updateTarget{Kind: "archive", URL: "https://github.com/thibautrey/multivibe/releases/download/v1.2.3/archive", Size: 10, SHA256: fmt.Sprintf("%064x", 1)}
	digest := "sha256:" + fmt.Sprintf("%064x", 2)
	return updateDocument{
		SchemaVersion: updateSchemaVersion, Channel: "stable", Version: "1.2.3", SourceCommit: fmt.Sprintf("%040x", 3),
		PublishedAt: now.Add(-time.Hour).Format(time.RFC3339Nano), ExpiresAt: now.Add(24 * time.Hour).Format(time.RFC3339Nano),
		MinimumVersion: "0.2.0", RolloutPercent: 100,
		Targets: map[string]updateTarget{
			"darwin-arm64": archive, "darwin-amd64": archive, "linux-amd64": archive, "windows-amd64": archive,
			"docker-linux-amd64": {Kind: "container", Image: "ghcr.io/thibautrey/multivibe-host", Digest: digest, ImmutableReference: "ghcr.io/thibautrey/multivibe-host@" + digest},
		},
	}
}

func TestVerifyUpdateEnvelope(t *testing.T) {
	now := time.Now().UTC()
	encoded := signedFixture(t, validDocument(now))
	document, err := verifyUpdateEnvelope(encoded, now, "stable")
	if err != nil || document.Version != "1.2.3" {
		t.Fatalf("valid update feed rejected: %#v %v", document, err)
	}
	encoded[len(encoded)/2] ^= 1
	if _, err := verifyUpdateEnvelope(encoded, now, "stable"); err == nil {
		t.Fatal("tampered update feed accepted")
	}
}

func TestExpiredUpdateEnvelopeFailsClosed(t *testing.T) {
	now := time.Now().UTC()
	document := validDocument(now)
	document.ExpiresAt = now.Add(-time.Minute).Format(time.RFC3339Nano)
	if _, err := verifyUpdateEnvelope(signedFixture(t, document), now, "stable"); err == nil {
		t.Fatal("expired update feed accepted")
	}
}

func TestCompareVersions(t *testing.T) {
	for _, fixture := range []struct {
		left, right string
		want        int
	}{
		{"1.2.3", "1.2.3", 0}, {"1.2.4", "1.2.3", 1}, {"1.2.3-beta.2", "1.2.3", -1}, {"2.0.0", "10.0.0", -1},
	} {
		got, err := compareVersions(fixture.left, fixture.right)
		if err != nil || got != fixture.want {
			t.Fatalf("compareVersions(%q,%q)=%d,%v want %d", fixture.left, fixture.right, got, err, fixture.want)
		}
	}
}

func TestTrustedProductionKeyIdentity(t *testing.T) {
	ids := trustedKeyIDs()
	if len(ids) != 1 || ids[0] != "8041964146f75ff5" {
		t.Fatalf("unexpected production trust roots: %v", ids)
	}
}
