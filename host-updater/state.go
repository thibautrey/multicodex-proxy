package main

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const updaterStateSchema = "multivibe-host-updater-state-v1"

type updaterState struct {
	SchemaVersion      string        `json:"schema_version"`
	Mode               string        `json:"mode"`
	Channel            string        `json:"channel"`
	RolloutBucket      int           `json:"rollout_bucket"`
	CurrentVersion     string        `json:"current_version"`
	Status             string        `json:"status"`
	LastCheckedAt      string        `json:"last_checked_at,omitempty"`
	NextCheckAt        string        `json:"next_check_at,omitempty"`
	FeedETag           string        `json:"feed_etag,omitempty"`
	AvailableVersion   string        `json:"available_version,omitempty"`
	AvailableCritical  bool          `json:"available_critical,omitempty"`
	RolloutEligible    bool          `json:"rollout_eligible,omitempty"`
	DownloadedPath     string        `json:"downloaded_path,omitempty"`
	DownloadedSHA256   string        `json:"downloaded_sha256,omitempty"`
	DownloadRequested  bool          `json:"download_requested,omitempty"`
	InstallRequested   bool          `json:"install_requested,omitempty"`
	Target             *updateTarget `json:"target,omitempty"`
	LastInstalledAt    string        `json:"last_installed_at,omitempty"`
	LastErrorCode      string        `json:"last_error_code,omitempty"`
	LastError          string        `json:"last_error,omitempty"`
	DockerComposeFile  string        `json:"docker_compose_file,omitempty"`
	DockerProjectDir   string        `json:"docker_project_dir,omitempty"`
	DockerOverrideFile string        `json:"docker_override_file,omitempty"`
	DockerPreviousRef  string        `json:"docker_previous_reference,omitempty"`
	DockerCurrentRef   string        `json:"docker_current_reference,omitempty"`
}

func defaultState(currentVersion string) (updaterState, error) {
	var randomValue [8]byte
	if _, err := rand.Read(randomValue[:]); err != nil {
		return updaterState{}, errors.New("cannot generate the local rollout bucket")
	}
	return updaterState{
		SchemaVersion:  updaterStateSchema,
		Mode:           "automatic",
		Channel:        "stable",
		RolloutBucket:  int(binary.BigEndian.Uint64(randomValue[:]) % 100),
		CurrentVersion: currentVersion,
		Status:         "idle",
	}, nil
}

func defaultDataDirectory() (string, error) {
	if configured := strings.TrimSpace(os.Getenv("MULTIVIBE_HOST_DATA_DIR")); configured != "" {
		if !filepath.IsAbs(configured) || filepath.Clean(configured) != configured || configured == string(filepath.Separator) {
			return "", errors.New("MULTIVIBE_HOST_DATA_DIR must be a clean absolute non-root path")
		}
		return configured, nil
	}
	home, err := os.UserHomeDir()
	if err != nil || !filepath.IsAbs(home) {
		return "", errors.New("the user home directory is unavailable")
	}
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support", "MultiVibe"), nil
	}
	if runtime.GOOS == "linux" {
		if xdg := strings.TrimSpace(os.Getenv("XDG_DATA_HOME")); xdg != "" {
			if !filepath.IsAbs(xdg) || filepath.Clean(xdg) != xdg {
				return "", errors.New("XDG_DATA_HOME must be a clean absolute path")
			}
			return filepath.Join(xdg, "multivibe"), nil
		}
		return filepath.Join(home, ".local", "share", "multivibe"), nil
	}
	if runtime.GOOS == "windows" {
		localAppData := strings.TrimSpace(os.Getenv("LOCALAPPDATA"))
		if localAppData == "" {
			localAppData = filepath.Join(home, "AppData", "Local")
		}
		if !filepath.IsAbs(localAppData) || filepath.Clean(localAppData) != localAppData {
			return "", errors.New("LOCALAPPDATA must be a clean absolute path")
		}
		return filepath.Join(localAppData, "MultiVibe"), nil
	}
	return "", errors.New("this operating system is unsupported")
}

type stateStore struct {
	directory string
	path      string
	cache     string
	log       string
}

func (store stateStore) lock() (func(), error) {
	path := filepath.Join(store.directory, "host-update.lock")
	for attempt := 0; attempt < 2; attempt++ {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_, writeErr := fmt.Fprintf(file, "%d\n", os.Getpid())
			closeErr := file.Close()
			if writeErr != nil || closeErr != nil {
				_ = os.Remove(path)
				return nil, errors.New("the update lock cannot be persisted")
			}
			return func() { _ = os.Remove(path) }, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, errors.New("the update lock cannot be created")
		}
		info, statErr := os.Lstat(path)
		if statErr != nil || !updaterPrivateFile(path, info) {
			return nil, errors.New("the update lock is invalid")
		}
		if time.Since(info.ModTime()) <= time.Hour {
			return nil, errors.New("another Host update operation is already running")
		}
		if removeErr := os.Remove(path); removeErr != nil {
			return nil, errors.New("a stale update lock cannot be cleared")
		}
	}
	return nil, errors.New("the update lock could not be acquired")
}

func openStateStore() (stateStore, error) {
	directory, err := defaultDataDirectory()
	if err != nil {
		return stateStore{}, err
	}
	if err := os.MkdirAll(directory, 0o700); err != nil || secureUpdaterPrivateDirectory(directory) != nil {
		return stateStore{}, errors.New("the MultiVibe data directory cannot be protected")
	}
	cache := filepath.Join(directory, "updates")
	if err := os.MkdirAll(cache, 0o700); err != nil || secureUpdaterPrivateDirectory(cache) != nil {
		return stateStore{}, errors.New("the update cache cannot be protected")
	}
	return stateStore{
		directory: directory,
		path:      filepath.Join(directory, "host-update-state.json"),
		cache:     cache,
		log:       filepath.Join(directory, "host-update.log"),
	}, nil
}

func (store stateStore) load(currentVersion string) (updaterState, error) {
	info, err := os.Lstat(store.path)
	if errors.Is(err, os.ErrNotExist) {
		return defaultState(currentVersion)
	}
	if err != nil || !updaterPrivateFile(store.path, info) || info.Size() < 2 || info.Size() > 256*1024 {
		return updaterState{}, errors.New("the update state file is invalid")
	}
	data, err := os.ReadFile(store.path)
	if err != nil {
		return updaterState{}, errors.New("the update state cannot be read")
	}
	var state updaterState
	if decodeStrictJSON(data, &state) != nil || validateState(state) != nil {
		return updaterState{}, errors.New("the update state is invalid")
	}
	return state, nil
}

func validateState(state updaterState) error {
	if state.SchemaVersion != updaterStateSchema || (state.Mode != "automatic" && state.Mode != "download" && state.Mode != "notify") ||
		(state.Channel != "stable" && state.Channel != "beta") || state.RolloutBucket < 0 || state.RolloutBucket > 99 ||
		!semanticVersionPattern.MatchString(state.CurrentVersion) {
		return errors.New("update state identity is invalid")
	}
	allowedStatus := map[string]bool{"idle": true, "checking": true, "available": true, "downloading": true, "downloaded": true, "installing": true, "current": true, "deferred": true, "failed": true}
	if !allowedStatus[state.Status] {
		return errors.New("update state status is invalid")
	}
	if len(state.FeedETag) > 256 || strings.ContainsAny(state.FeedETag, "\r\n") {
		return errors.New("update state ETag is invalid")
	}
	for _, timestamp := range []string{state.LastCheckedAt, state.NextCheckAt, state.LastInstalledAt} {
		if timestamp != "" {
			if _, err := time.Parse(time.RFC3339Nano, timestamp); err != nil {
				return errors.New("update state timestamp is invalid")
			}
		}
	}
	return nil
}

func (store stateStore) save(state updaterState) error {
	if err := validateState(state); err != nil {
		return err
	}
	encoded, err := json.MarshalIndent(state, "", "  ")
	if err != nil || len(encoded) > 256*1024 {
		return errors.New("the update state cannot be encoded")
	}
	temporary, err := os.CreateTemp(store.directory, ".host-update-state.*")
	if err != nil {
		return errors.New("the update state cannot be staged")
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		_ = temporary.Close()
		if !committed {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := secureUpdaterPrivateFile(temporaryPath); err != nil {
		return errors.New("the staged update state cannot be protected")
	}
	if _, err := temporary.Write(append(encoded, '\n')); err != nil || temporary.Sync() != nil || temporary.Close() != nil {
		return errors.New("the update state cannot be persisted")
	}
	if err := replaceUpdaterFile(temporaryPath, store.path); err != nil {
		return errors.New("the update state cannot be committed")
	}
	committed = true
	return nil
}

func nextCheck(now time.Time) string {
	var randomValue [2]byte
	_, _ = rand.Read(randomValue[:])
	jitter := time.Duration(binary.BigEndian.Uint16(randomValue[:])%241) * time.Minute
	return now.UTC().Add(10*time.Hour + jitter).Format(time.RFC3339Nano)
}

func publicState(state updaterState) map[string]any {
	return map[string]any{
		"schema_version":     state.SchemaVersion,
		"mode":               state.Mode,
		"channel":            state.Channel,
		"current_version":    state.CurrentVersion,
		"status":             state.Status,
		"last_checked_at":    emptyAsNil(state.LastCheckedAt),
		"next_check_at":      emptyAsNil(state.NextCheckAt),
		"available_version":  emptyAsNil(state.AvailableVersion),
		"available_critical": state.AvailableCritical,
		"rollout_eligible":   state.RolloutEligible,
		"downloaded":         state.DownloadedPath != "",
		"download_requested": state.DownloadRequested,
		"install_requested":  state.InstallRequested,
		"last_installed_at":  emptyAsNil(state.LastInstalledAt),
		"last_error_code":    emptyAsNil(state.LastErrorCode),
		"last_error":         emptyAsNil(state.LastError),
		"container_managed":  state.DockerComposeFile != "",
	}
}

func emptyAsNil(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func setFailure(store stateStore, state *updaterState, code string, err error) error {
	state.Status = "failed"
	state.LastErrorCode = code
	state.LastError = err.Error()
	if saveErr := store.save(*state); saveErr != nil {
		return fmt.Errorf("%s; additionally failed to save update state: %v", err, saveErr)
	}
	return err
}
