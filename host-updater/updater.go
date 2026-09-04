package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const defaultFeedPrefix = "https://github.com/thibautrey/multivibe/releases/latest/download/multivibe-host-update-"

var hostUpdaterVersion = "0.0.0-dev"

type updater struct {
	store      stateStore
	httpClient *http.Client
	now        func() time.Time
	container  bool
}

func newUpdater(container bool) (*updater, updaterState, error) {
	store, err := openStateStore()
	if err != nil {
		return nil, updaterState{}, err
	}
	state, err := store.load(hostUpdaterVersion)
	if err != nil {
		return nil, updaterState{}, err
	}
	if !container {
		state.CurrentVersion = hostUpdaterVersion
	}
	client := &http.Client{
		Timeout: 60 * time.Second,
		CheckRedirect: func(request *http.Request, via []*http.Request) error {
			if len(via) >= 5 {
				return errors.New("too many update download redirects")
			}
			if !allowedDownloadHost(request.URL) {
				return errors.New("update redirect host is not allowed")
			}
			return nil
		},
	}
	return &updater{store: store, httpClient: client, now: time.Now, container: container}, state, nil
}

func allowedDownloadHost(parsed *url.URL) bool {
	if parsed == nil || parsed.Scheme != "https" || parsed.User != nil {
		return false
	}
	switch parsed.Hostname() {
	case "github.com", "api.github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com":
		return true
	default:
		return false
	}
}

func (update *updater) feedURL(channel string) (string, error) {
	if configured := strings.TrimSpace(os.Getenv("MULTIVIBE_UPDATE_FEED_URL")); configured != "" {
		parsed, err := url.Parse(configured)
		if err != nil || !allowedDownloadHost(parsed) || parsed.RawQuery != "" || parsed.Fragment != "" {
			return "", errors.New("MULTIVIBE_UPDATE_FEED_URL is not an allowed HTTPS URL")
		}
		return configured, nil
	}
	if channel != "stable" && channel != "beta" {
		return "", errors.New("update channel is invalid")
	}
	if channel == "beta" {
		return "https://api.github.com/repos/thibautrey/multivibe/releases?per_page=10", nil
	}
	return defaultFeedPrefix + channel + ".json", nil
}

func (update *updater) fetchFeed(ctx context.Context, channel, etag string) ([]byte, string, bool, error) {
	feedURL, err := update.feedURL(channel)
	if err != nil {
		return nil, "", false, err
	}
	fetch := func(rawURL, accept, conditionalETag string, maximum int64) ([]byte, string, bool, error) {
		request, requestErr := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
		if requestErr != nil {
			return nil, "", false, requestErr
		}
		request.Header.Set("Accept", accept)
		request.Header.Set("User-Agent", "MultiVibe-Host-Updater/"+hostUpdaterVersion)
		if conditionalETag != "" {
			request.Header.Set("If-None-Match", conditionalETag)
		}
		response, responseErr := update.httpClient.Do(request)
		if responseErr != nil {
			return nil, "", false, errors.New("the signed update feed could not be downloaded")
		}
		defer response.Body.Close()
		responseETag := response.Header.Get("ETag")
		if len(responseETag) > 256 || strings.ContainsAny(responseETag, "\r\n") {
			responseETag = ""
		}
		if response.StatusCode == http.StatusNotModified {
			return nil, responseETag, true, nil
		}
		if response.StatusCode != http.StatusOK {
			return nil, "", false, fmt.Errorf("the update feed returned HTTP %d", response.StatusCode)
		}
		data, readErr := io.ReadAll(io.LimitReader(response.Body, maximum+1))
		if readErr != nil || int64(len(data)) > maximum {
			return nil, "", false, errors.New("the update feed could not be read safely")
		}
		return data, responseETag, false, nil
	}
	data, responseETag, notModified, err := fetch(feedURL, "application/vnd.github+json", etag, maximumFeedBytes)
	parsedFeedURL, _ := url.Parse(feedURL)
	if err != nil || channel != "beta" || parsedFeedURL.Hostname() != "api.github.com" {
		return data, responseETag, notModified, err
	}
	if notModified {
		return nil, responseETag, true, nil
	}
	var releases []struct {
		Draft      bool `json:"draft"`
		Prerelease bool `json:"prerelease"`
		Assets     []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if json.Unmarshal(data, &releases) != nil {
		return nil, "", false, errors.New("the GitHub beta release index is invalid")
	}
	for _, release := range releases {
		if release.Draft || !release.Prerelease {
			continue
		}
		for _, asset := range release.Assets {
			if asset.Name == "multivibe-host-update-beta.json" && validReleaseURL(asset.URL) {
				feed, _, _, feedErr := fetch(asset.URL, "application/json", "", maximumFeedBytes)
				return feed, responseETag, false, feedErr
			}
		}
	}
	return nil, "", false, errors.New("no signed MultiVibe Host beta update feed is published")
}

func (update *updater) check(ctx context.Context, state *updaterState, force bool) error {
	now := update.now().UTC()
	if !force && state.NextCheckAt != "" {
		next, err := time.Parse(time.RFC3339Nano, state.NextCheckAt)
		if err == nil && now.Before(next) {
			return nil
		}
	}
	state.Status = "checking"
	state.LastError = ""
	state.LastErrorCode = ""
	if err := update.store.save(*state); err != nil {
		return err
	}
	data, etag, notModified, err := update.fetchFeed(ctx, state.Channel, state.FeedETag)
	if err != nil {
		return setFailure(update.store, state, "feed_download_failed", err)
	}
	if notModified {
		state.LastCheckedAt = now.Format(time.RFC3339Nano)
		state.NextCheckAt = nextCheck(now)
		if etag != "" {
			state.FeedETag = etag
		}
		restoreCachedStatus(state)
		return update.store.save(*state)
	}
	document, err := verifyUpdateEnvelope(data, now, state.Channel)
	if err != nil {
		return setFailure(update.store, state, "feed_verification_failed", err)
	}
	name, err := targetName(update.container)
	if err != nil {
		return setFailure(update.store, state, "platform_unsupported", err)
	}
	target := document.Targets[name]
	comparison, err := compareVersions(document.Version, state.CurrentVersion)
	if err != nil {
		return setFailure(update.store, state, "version_invalid", err)
	}
	minimumComparison, err := compareVersions(state.CurrentVersion, document.MinimumVersion)
	if err != nil {
		return setFailure(update.store, state, "minimum_version_invalid", err)
	}
	state.LastCheckedAt = now.Format(time.RFC3339Nano)
	state.NextCheckAt = nextCheck(now)
	state.FeedETag = etag
	previousVersion := state.AvailableVersion
	previousPath := state.DownloadedPath
	previousSHA256 := state.DownloadedSHA256
	previousTarget := state.Target
	state.AvailableVersion = ""
	state.AvailableCritical = false
	state.RolloutEligible = false
	state.Target = nil
	state.DownloadedPath = ""
	state.DownloadedSHA256 = ""
	if comparison <= 0 {
		state.DownloadRequested = false
		state.InstallRequested = false
		state.Status = "current"
		return update.store.save(*state)
	}
	eligible := state.RolloutBucket < document.RolloutPercent || document.Critical || minimumComparison < 0
	state.AvailableVersion = document.Version
	state.AvailableCritical = document.Critical || minimumComparison < 0
	state.RolloutEligible = eligible
	state.Target = &target
	if eligible {
		if previousVersion == document.Version && previousTarget != nil && sameArchiveTarget(*previousTarget, target) &&
			previousSHA256 == target.SHA256 && downloadLooksPresent(previousPath, target.Size) {
			state.DownloadedPath = previousPath
			state.DownloadedSHA256 = previousSHA256
			state.Status = "downloaded"
		} else {
			state.DownloadRequested = false
			state.InstallRequested = false
			state.Status = "available"
		}
	} else {
		state.DownloadRequested = false
		state.InstallRequested = false
		state.Status = "deferred"
	}
	return update.store.save(*state)
}

func sameArchiveTarget(left, right updateTarget) bool {
	return left.Kind == "archive" && right.Kind == "archive" && left.Size == right.Size && left.SHA256 == right.SHA256
}

func downloadLooksPresent(path string, expectedSize int64) bool {
	info, err := os.Lstat(path)
	return err == nil && updaterPrivateFile(path, info) && info.Size() == expectedSize
}

func restoreCachedStatus(state *updaterState) {
	if state.Target == nil || state.AvailableVersion == "" {
		state.Status = "current"
		return
	}
	if !state.RolloutEligible {
		state.Status = "deferred"
		return
	}
	if state.DownloadedPath != "" {
		state.Status = "downloaded"
		return
	}
	state.Status = "available"
}

func (update *updater) download(ctx context.Context, state *updaterState) error {
	if state.Target == nil || state.AvailableVersion == "" || !state.RolloutEligible {
		return errors.New("no eligible update is available")
	}
	if state.Target.Kind == "container" {
		return errors.New("container updates are pulled by the Docker orchestrator")
	}
	state.Status = "downloading"
	state.LastError = ""
	state.LastErrorCode = ""
	if err := update.store.save(*state); err != nil {
		return err
	}
	extension := ".tar.gz"
	if strings.HasPrefix(runtimeTargetName(), "darwin-") {
		extension = ".dmg"
	} else if runtimeTargetName() == "windows-amd64" {
		extension = ".zip"
	}
	destination := filepath.Join(update.store.cache, "multivibe-host_"+state.AvailableVersion+extension)
	temporary, err := os.CreateTemp(update.store.cache, ".download-*")
	if err != nil {
		return setFailure(update.store, state, "download_stage_failed", errors.New("the update download could not be staged"))
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
		return setFailure(update.store, state, "download_stage_failed", err)
	}
	parts := state.Target.Parts
	if state.Target.URL != "" {
		parts = []artifactPart{{URL: state.Target.URL, Size: state.Target.Size, SHA256: state.Target.SHA256}}
	}
	totalHash := sha256.New()
	var total int64
	for _, part := range parts {
		partHash := sha256.New()
		written, err := update.downloadPart(ctx, io.MultiWriter(temporary, totalHash, partHash), part)
		if err != nil {
			return setFailure(update.store, state, "artifact_download_failed", err)
		}
		if written != part.Size || hex.EncodeToString(partHash.Sum(nil)) != part.SHA256 {
			return setFailure(update.store, state, "artifact_part_verification_failed", errors.New("an update archive part failed verification"))
		}
		total += written
	}
	if total != state.Target.Size || hex.EncodeToString(totalHash.Sum(nil)) != state.Target.SHA256 {
		return setFailure(update.store, state, "artifact_verification_failed", errors.New("the downloaded update archive failed verification"))
	}
	if temporary.Sync() != nil || temporary.Close() != nil {
		return setFailure(update.store, state, "artifact_persist_failed", errors.New("the downloaded update archive could not be persisted"))
	}
	if err := replaceUpdaterFile(temporaryPath, destination); err != nil {
		return setFailure(update.store, state, "artifact_commit_failed", err)
	}
	committed = true
	state.Status = "downloaded"
	state.DownloadedPath = destination
	state.DownloadedSHA256 = state.Target.SHA256
	state.DownloadRequested = false
	return update.store.save(*state)
}

func runtimeTargetName() string {
	name, _ := targetName(false)
	return name
}

func (update *updater) downloadPart(ctx context.Context, writer io.Writer, part artifactPart) (int64, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, part.URL, nil)
	if err != nil {
		return 0, errors.New("the update archive request is invalid")
	}
	request.Header.Set("Accept", "application/octet-stream")
	request.Header.Set("User-Agent", "MultiVibe-Host-Updater/"+hostUpdaterVersion)
	response, err := update.httpClient.Do(request)
	if err != nil {
		return 0, errors.New("the update archive could not be downloaded")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return 0, fmt.Errorf("the update archive returned HTTP %d", response.StatusCode)
	}
	limited := io.LimitReader(response.Body, part.Size+1)
	written, err := io.Copy(writer, limited)
	if err != nil || written > part.Size {
		return written, errors.New("the update archive download is invalid")
	}
	return written, nil
}

func encodePublicStatus(state updaterState) error {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(true)
	return encoder.Encode(publicState(state))
}
