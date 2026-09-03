package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	updateSchemaVersion  = "multivibe-host-update-v1"
	maximumFeedBytes     = 2 * 1024 * 1024
	maximumArtifactBytes = int64(6 * 1024 * 1024 * 1024)
)

var (
	semanticVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$`)
	hexDigestPattern       = regexp.MustCompile(`^[0-9a-f]{64}$`)
	containerDigestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	commitPattern          = regexp.MustCompile(`^[0-9a-f]{40}$`)
	trustedUpdateKeys      = map[string]string{
		"701058786335e61e": "PToWAREA+GGggKzfdhP6Z6i3IqX/SsBwFmHOrtz3Dj0=",
	}
)

type updateEnvelope struct {
	Signed     string            `json:"signed"`
	Signatures []updateSignature `json:"signatures"`
}

type updateSignature struct {
	KeyID     string `json:"key_id"`
	Algorithm string `json:"algorithm"`
	Signature string `json:"signature"`
}

type updateDocument struct {
	SchemaVersion  string                  `json:"schema_version"`
	Channel        string                  `json:"channel"`
	Version        string                  `json:"version"`
	SourceCommit   string                  `json:"source_commit"`
	PublishedAt    string                  `json:"published_at"`
	ExpiresAt      string                  `json:"expires_at"`
	MinimumVersion string                  `json:"minimum_version"`
	RolloutPercent int                     `json:"rollout_percent"`
	Critical       bool                    `json:"critical"`
	Targets        map[string]updateTarget `json:"targets"`
}

type updateTarget struct {
	Kind               string         `json:"kind"`
	URL                string         `json:"url,omitempty"`
	Size               int64          `json:"size,omitempty"`
	SHA256             string         `json:"sha256,omitempty"`
	Parts              []artifactPart `json:"parts,omitempty"`
	Image              string         `json:"image,omitempty"`
	Digest             string         `json:"digest,omitempty"`
	ImmutableReference string         `json:"immutable_reference,omitempty"`
}

type artifactPart struct {
	URL    string `json:"url"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

func decodeStrictJSON(data []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("JSON document contains trailing data")
	}
	return nil
}

func verifyUpdateEnvelope(data []byte, now time.Time, channel string) (updateDocument, error) {
	if len(data) == 0 || len(data) > maximumFeedBytes {
		return updateDocument{}, errors.New("update feed size is invalid")
	}
	var envelope updateEnvelope
	if err := decodeStrictJSON(data, &envelope); err != nil || envelope.Signed == "" || len(envelope.Signatures) < 1 || len(envelope.Signatures) > 8 {
		return updateDocument{}, errors.New("update feed envelope is invalid")
	}
	signed, err := base64.RawURLEncoding.DecodeString(envelope.Signed)
	if err != nil || len(signed) == 0 || len(signed) > maximumFeedBytes {
		return updateDocument{}, errors.New("update feed signed payload is invalid")
	}
	verified := make(map[string]bool)
	for _, signature := range envelope.Signatures {
		encodedKey, trusted := trustedUpdateKeys[signature.KeyID]
		if !trusted || signature.Algorithm != "ed25519" || verified[signature.KeyID] {
			continue
		}
		publicKey, keyErr := base64.StdEncoding.DecodeString(encodedKey)
		rawSignature, signatureErr := base64.RawURLEncoding.DecodeString(signature.Signature)
		if keyErr == nil && signatureErr == nil && len(publicKey) == ed25519.PublicKeySize &&
			ed25519.Verify(ed25519.PublicKey(publicKey), signed, rawSignature) {
			verified[signature.KeyID] = true
		}
	}
	if len(verified) < 1 {
		return updateDocument{}, errors.New("update feed signature is not trusted")
	}
	var document updateDocument
	if err := decodeStrictJSON(signed, &document); err != nil {
		return updateDocument{}, errors.New("update feed payload is invalid")
	}
	if err := validateUpdateDocument(document, now.UTC(), channel); err != nil {
		return updateDocument{}, err
	}
	return document, nil
}

func validateUpdateDocument(document updateDocument, now time.Time, channel string) error {
	if document.SchemaVersion != updateSchemaVersion || document.Channel != channel ||
		!semanticVersionPattern.MatchString(document.Version) || !semanticVersionPattern.MatchString(document.MinimumVersion) ||
		!commitPattern.MatchString(document.SourceCommit) || document.RolloutPercent < 0 || document.RolloutPercent > 100 {
		return errors.New("update feed identity is invalid")
	}
	if channel == "stable" && strings.Contains(document.Version, "-") {
		return errors.New("stable update feed contains a prerelease")
	}
	published, err := time.Parse(time.RFC3339Nano, document.PublishedAt)
	if err != nil || published.After(now.Add(10*time.Minute)) {
		return errors.New("update feed publication time is invalid")
	}
	expires, err := time.Parse(time.RFC3339Nano, document.ExpiresAt)
	if err != nil || !expires.After(now) || !expires.After(published) || expires.Sub(published) > 366*24*time.Hour {
		return errors.New("update feed is expired or has an invalid lifetime")
	}
	requiredTargets := []string{"darwin-arm64", "darwin-amd64", "linux-amd64", "docker-linux-amd64"}
	if len(document.Targets) != len(requiredTargets) {
		return errors.New("update feed target set is invalid")
	}
	for _, name := range requiredTargets {
		target, exists := document.Targets[name]
		if !exists {
			return fmt.Errorf("update feed target is missing: %s", name)
		}
		if err := validateTarget(name, target); err != nil {
			return err
		}
	}
	return nil
}

func validateTarget(name string, target updateTarget) error {
	if name == "docker-linux-amd64" {
		if target.Kind != "container" || target.Image != "ghcr.io/thibautrey/multivibe-host" ||
			!containerDigestPattern.MatchString(target.Digest) || target.ImmutableReference != target.Image+"@"+target.Digest ||
			target.URL != "" || target.Size != 0 || target.SHA256 != "" || len(target.Parts) != 0 {
			return errors.New("container update target is invalid")
		}
		return nil
	}
	if target.Kind != "archive" || target.Size < 1 || target.Size > maximumArtifactBytes || !hexDigestPattern.MatchString(target.SHA256) ||
		target.Image != "" || target.Digest != "" || target.ImmutableReference != "" {
		return fmt.Errorf("archive update target is invalid: %s", name)
	}
	if target.URL != "" {
		if len(target.Parts) != 0 || !validReleaseURL(target.URL) {
			return fmt.Errorf("archive update URL is invalid: %s", name)
		}
		return nil
	}
	if len(target.Parts) < 2 || len(target.Parts) > 16 {
		return fmt.Errorf("multipart archive target is invalid: %s", name)
	}
	var total int64
	for _, part := range target.Parts {
		if part.Size < 1 || part.Size > 2*1024*1024*1024 || !hexDigestPattern.MatchString(part.SHA256) || !validReleaseURL(part.URL) {
			return fmt.Errorf("multipart archive part is invalid: %s", name)
		}
		total += part.Size
	}
	if total != target.Size {
		return fmt.Errorf("multipart archive size is invalid: %s", name)
	}
	return nil
}

func validReleaseURL(raw string) bool {
	parsed, err := url.Parse(raw)
	return err == nil && parsed.Scheme == "https" && parsed.Host == "github.com" && parsed.User == nil &&
		parsed.RawQuery == "" && parsed.Fragment == "" && strings.HasPrefix(parsed.EscapedPath(), "/thibautrey/multivibe/releases/download/v")
}

func targetName(container bool) (string, error) {
	if container {
		if runtime.GOOS != "linux" || runtime.GOARCH != "amd64" {
			return "", errors.New("Docker Host updates require Linux amd64")
		}
		return "docker-linux-amd64", nil
	}
	if runtime.GOOS == "darwin" && (runtime.GOARCH == "arm64" || runtime.GOARCH == "amd64") {
		return "darwin-" + runtime.GOARCH, nil
	}
	if runtime.GOOS == "linux" && runtime.GOARCH == "amd64" {
		return "linux-amd64", nil
	}
	return "", errors.New("this operating system and architecture are unsupported")
}

type parsedVersion struct {
	major, minor, patch uint64
	prerelease          string
}

func parseVersion(value string) (parsedVersion, error) {
	if !semanticVersionPattern.MatchString(value) {
		return parsedVersion{}, errors.New("version is invalid")
	}
	main, prerelease, _ := strings.Cut(value, "-")
	parts := strings.Split(main, ".")
	values := make([]uint64, 3)
	for index, part := range parts {
		if len(part) > 1 && part[0] == '0' {
			return parsedVersion{}, errors.New("version is not canonical")
		}
		parsed, err := strconv.ParseUint(part, 10, 63)
		if err != nil {
			return parsedVersion{}, errors.New("version is invalid")
		}
		values[index] = parsed
	}
	return parsedVersion{major: values[0], minor: values[1], patch: values[2], prerelease: prerelease}, nil
}

func compareVersions(left, right string) (int, error) {
	a, err := parseVersion(left)
	if err != nil {
		return 0, err
	}
	b, err := parseVersion(right)
	if err != nil {
		return 0, err
	}
	leftNumbers := []uint64{a.major, a.minor, a.patch}
	rightNumbers := []uint64{b.major, b.minor, b.patch}
	for index := range leftNumbers {
		if leftNumbers[index] < rightNumbers[index] {
			return -1, nil
		}
		if leftNumbers[index] > rightNumbers[index] {
			return 1, nil
		}
	}
	if a.prerelease == b.prerelease {
		return 0, nil
	}
	if a.prerelease == "" {
		return 1, nil
	}
	if b.prerelease == "" {
		return -1, nil
	}
	leftIdentifiers := strings.Split(a.prerelease, ".")
	rightIdentifiers := strings.Split(b.prerelease, ".")
	for index := 0; index < len(leftIdentifiers) && index < len(rightIdentifiers); index++ {
		if leftIdentifiers[index] == rightIdentifiers[index] {
			continue
		}
		leftNumber, leftErr := strconv.ParseUint(leftIdentifiers[index], 10, 63)
		rightNumber, rightErr := strconv.ParseUint(rightIdentifiers[index], 10, 63)
		if leftErr == nil && rightErr == nil {
			if leftNumber < rightNumber {
				return -1, nil
			}
			return 1, nil
		}
		if leftErr == nil {
			return -1, nil
		}
		if rightErr == nil {
			return 1, nil
		}
		if leftIdentifiers[index] < rightIdentifiers[index] {
			return -1, nil
		}
		return 1, nil
	}
	if len(leftIdentifiers) < len(rightIdentifiers) {
		return -1, nil
	}
	return 1, nil
}

func trustedKeyIDs() []string {
	ids := make([]string, 0, len(trustedUpdateKeys))
	for id, encoded := range trustedUpdateKeys {
		raw, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(raw) != ed25519.PublicKeySize {
			continue
		}
		digest := sha256.Sum256(raw)
		if fmt.Sprintf("%x", digest[:8]) == id {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}
