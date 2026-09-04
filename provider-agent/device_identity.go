package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
)

const deviceIdentitySchemaVersion = "provider-device-identity-v1"

type deviceIdentityDocument struct {
	SchemaVersion   string `json:"schema_version"`
	PrivateKeyPKCS8 string `json:"private_key_pkcs8"`
	PublicKeySPKI   string `json:"public_key_spki"`
	DeviceKeyID     string `json:"device_key_id"`
	Sequence        uint64 `json:"sequence"`
}

type deviceIdentity struct {
	mu            sync.Mutex
	path          string
	privateKey    ed25519.PrivateKey
	publicKeySPKI string
	deviceKeyID   string
	sequence      uint64
}

func deriveDeviceIdentity(privateKey ed25519.PrivateKey) (string, string, error) {
	publicKey, ok := privateKey.Public().(ed25519.PublicKey)
	if !ok {
		return "", "", errors.New("provider device identity public key is invalid")
	}
	spki, err := x509.MarshalPKIXPublicKey(publicKey)
	if err != nil {
		return "", "", errors.New("provider device identity public key cannot be encoded")
	}
	digest := sha256.Sum256(spki)
	return base64.RawURLEncoding.EncodeToString(spki), "ed25519:" + base64.RawURLEncoding.EncodeToString(digest[:]), nil
}

func newMemoryDeviceIdentity() (*deviceIdentity, error) {
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, errors.New("provider device identity cannot be generated")
	}
	spki, keyID, err := deriveDeviceIdentity(privateKey)
	if err != nil {
		return nil, err
	}
	return &deviceIdentity{privateKey: privateKey, publicKeySPKI: spki, deviceKeyID: keyID}, nil
}

func openDeviceIdentity(path string) (*deviceIdentity, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path {
		return nil, errors.New("provider device identity path must be a clean absolute path")
	}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		identity, generateErr := newMemoryDeviceIdentity()
		if generateErr != nil {
			return nil, generateErr
		}
		identity.path = path
		if persistErr := identity.persistLocked(); persistErr != nil {
			return nil, persistErr
		}
		return identity, nil
	}
	if err != nil {
		return nil, errors.New("provider device identity cannot be inspected")
	}
	if !providerPrivateFile(path, info) || info.Size() > 16*1024 {
		return nil, errors.New("provider device identity must be a bounded mode-0600 regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, errors.New("provider device identity cannot be opened")
	}
	defer file.Close()
	var document deviceIdentityDocument
	decoder := json.NewDecoder(io.LimitReader(file, 16*1024+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil || ensureJSONEOF(decoder) != nil || document.SchemaVersion != deviceIdentitySchemaVersion {
		return nil, errors.New("provider device identity is invalid")
	}
	pkcs8, err := base64.RawURLEncoding.DecodeString(document.PrivateKeyPKCS8)
	if err != nil || base64.RawURLEncoding.EncodeToString(pkcs8) != document.PrivateKeyPKCS8 {
		return nil, errors.New("provider device identity is invalid")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(pkcs8)
	privateKey, ok := parsed.(ed25519.PrivateKey)
	if err != nil || !ok || len(privateKey) != ed25519.PrivateKeySize {
		return nil, errors.New("provider device identity is invalid")
	}
	spki, keyID, err := deriveDeviceIdentity(privateKey)
	if err != nil || spki != document.PublicKeySPKI || keyID != document.DeviceKeyID || document.Sequence > maxRelaySequence {
		return nil, errors.New("provider device identity is invalid")
	}
	return &deviceIdentity{
		path: path, privateKey: privateKey, publicKeySPKI: spki, deviceKeyID: keyID, sequence: document.Sequence,
	}, nil
}

func (identity *deviceIdentity) publicIdentity() (string, string) {
	identity.mu.Lock()
	defer identity.mu.Unlock()
	return identity.deviceKeyID, identity.publicKeySPKI
}

func (identity *deviceIdentity) persistLocked() error {
	pkcs8, err := x509.MarshalPKCS8PrivateKey(identity.privateKey)
	if err != nil {
		return errors.New("provider device identity cannot be encoded")
	}
	document := deviceIdentityDocument{
		SchemaVersion:   deviceIdentitySchemaVersion,
		PrivateKeyPKCS8: base64.RawURLEncoding.EncodeToString(pkcs8),
		PublicKeySPKI:   identity.publicKeySPKI,
		DeviceKeyID:     identity.deviceKeyID,
		Sequence:        identity.sequence,
	}
	encoded, err := json.Marshal(document)
	if err != nil || len(encoded) > 16*1024 {
		return errors.New("provider device identity cannot be encoded")
	}
	if err := atomicWrite0600(identity.path, append(encoded, '\n')); err != nil {
		return errors.New("provider device identity cannot be committed")
	}
	return nil
}
