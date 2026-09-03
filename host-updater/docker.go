package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

var dockerImageReference = regexp.MustCompile(`^ghcr\.io/thibautrey/multivibe-host(?::[0-9A-Za-z._-]+|@sha256:[0-9a-f]{64})$`)
var dockerImageID = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

func validateCleanAbsoluteFile(value, description string) (string, error) {
	if !filepath.IsAbs(value) || filepath.Clean(value) != value || value == string(filepath.Separator) {
		return "", fmt.Errorf("%s must be a clean absolute path", description)
	}
	info, err := os.Lstat(value)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("%s must be a regular non-symlink file", description)
	}
	return value, nil
}

func (update *updater) configureDocker(state *updaterState, composeFile, projectDirectory string) error {
	validatedCompose, err := validateCleanAbsoluteFile(composeFile, "the Docker Compose file")
	if err != nil {
		return err
	}
	if !filepath.IsAbs(projectDirectory) || filepath.Clean(projectDirectory) != projectDirectory || projectDirectory == string(filepath.Separator) {
		return errors.New("the Docker project directory must be a clean absolute non-root path")
	}
	info, err := os.Lstat(projectDirectory)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("the Docker project directory is invalid")
	}
	configurationRoot, err := os.UserConfigDir()
	if err != nil || !filepath.IsAbs(configurationRoot) {
		return errors.New("the user configuration directory is unavailable")
	}
	configurationDirectory := filepath.Join(configurationRoot, "multivibe")
	if err := os.MkdirAll(configurationDirectory, 0o700); err != nil || os.Chmod(configurationDirectory, 0o700) != nil {
		return errors.New("the Docker updater configuration directory cannot be protected")
	}
	state.DockerComposeFile = validatedCompose
	state.DockerProjectDir = projectDirectory
	state.DockerOverrideFile = filepath.Join(configurationDirectory, "docker-compose.host.update.yml")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	version, err := dockerCommand(ctx, projectDirectory, "inspect", "--format", `{{ index .Config.Labels "org.opencontainers.image.version" }}`, "multivibe-host")
	if err != nil || !semanticVersionPattern.MatchString(version) {
		return errors.New("the running MultiVibe Host container version is unavailable")
	}
	reference, err := update.currentDockerReference(ctx, *state)
	if err != nil {
		return err
	}
	state.CurrentVersion = version
	state.DockerCurrentRef = reference
	return update.store.save(*state)
}

func dockerCommand(ctx context.Context, projectDirectory string, arguments ...string) (string, error) {
	command := exec.CommandContext(ctx, "docker", arguments...)
	command.Dir = projectDirectory
	command.Env = os.Environ()
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if len(message) > 500 {
			message = message[:500]
		}
		if message == "" {
			message = err.Error()
		}
		return "", errors.New(message)
	}
	return strings.TrimSpace(stdout.String()), nil
}

func writeDockerOverride(path, reference string) error {
	if !dockerImageReference.MatchString(reference) {
		return errors.New("the Docker image reference is invalid")
	}
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, ".docker-compose-update-*")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	committed := false
	defer func() {
		_ = temporary.Close()
		if !committed {
			_ = os.Remove(temporaryPath)
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return err
	}
	contents := "# Managed by MultiVibe Host updater\nservices:\n  multivibe-host:\n    image: " + reference + "\n"
	if _, err := temporary.WriteString(contents); err != nil || temporary.Sync() != nil || temporary.Close() != nil {
		return errors.New("the Docker update override could not be persisted")
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return err
	}
	committed = true
	return nil
}

func (update *updater) currentDockerReference(ctx context.Context, state updaterState) (string, error) {
	configured, err := dockerCommand(ctx, state.DockerProjectDir, "inspect", "--format", "{{.Config.Image}}", "multivibe-host")
	if err != nil {
		return "", errors.New("the running MultiVibe Host container cannot be inspected")
	}
	if !dockerImageReference.MatchString(configured) {
		return "", errors.New("the running container does not use the official MultiVibe Host image")
	}
	imageID, err := dockerCommand(ctx, state.DockerProjectDir, "inspect", "--format", "{{.Image}}", "multivibe-host")
	if err != nil || !dockerImageID.MatchString(imageID) {
		return "", errors.New("the running container image identity is unavailable")
	}
	repoDigests, err := dockerCommand(ctx, state.DockerProjectDir, "image", "inspect", "--format", "{{json .RepoDigests}}", imageID)
	if err != nil {
		return "", errors.New("the running container image digest is unavailable")
	}
	return officialDockerRepoDigest(repoDigests)
}

func officialDockerRepoDigest(encoded string) (string, error) {
	var values []string
	if err := json.Unmarshal([]byte(encoded), &values); err != nil || len(values) == 0 || len(values) > 64 {
		return "", errors.New("the running container repository digests are invalid")
	}
	valid := make(map[string]bool)
	for _, value := range values {
		if strings.HasPrefix(value, "ghcr.io/thibautrey/multivibe-host@") && dockerImageReference.MatchString(value) {
			valid[value] = true
		}
	}
	if len(valid) == 0 {
		return "", errors.New("the running container has no immutable official MultiVibe digest")
	}
	candidates := make([]string, 0, len(valid))
	for value := range valid {
		candidates = append(candidates, value)
	}
	sort.Strings(candidates)
	return candidates[0], nil
}

func (update *updater) runCompose(ctx context.Context, state updaterState) error {
	_, err := dockerCommand(ctx, state.DockerProjectDir,
		"compose", "--project-directory", state.DockerProjectDir,
		"-f", state.DockerComposeFile, "-f", state.DockerOverrideFile,
		"up", "-d", "--wait", "--wait-timeout", "120", "multivibe-host")
	return err
}

func (update *updater) applyDocker(ctx context.Context, state *updaterState) error {
	if state.Target == nil || state.Target.Kind != "container" || state.AvailableVersion == "" || !state.RolloutEligible {
		return errors.New("no eligible container update is available")
	}
	if state.DockerComposeFile == "" || state.DockerProjectDir == "" || state.DockerOverrideFile == "" {
		return setFailure(update.store, state, "docker_not_configured", errors.New("the Docker Host updater is not configured"))
	}
	previous, err := update.currentDockerReference(ctx, *state)
	if err != nil {
		return setFailure(update.store, state, "docker_inspect_failed", err)
	}
	next := state.Target.ImmutableReference
	if previous == next {
		state.Status = "current"
		state.AvailableVersion = ""
		state.Target = nil
		return update.store.save(*state)
	}
	state.Status = "installing"
	state.DockerPreviousRef = previous
	if err := update.store.save(*state); err != nil {
		return err
	}
	pullContext, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	if _, err := dockerCommand(pullContext, state.DockerProjectDir, "pull", next); err != nil {
		return setFailure(update.store, state, "docker_pull_failed", errors.New("the signed MultiVibe Host image could not be pulled"))
	}
	if err := writeDockerOverride(state.DockerOverrideFile, next); err != nil {
		return setFailure(update.store, state, "docker_override_failed", err)
	}
	if err := update.runCompose(ctx, *state); err != nil {
		rollbackWriteErr := writeDockerOverride(state.DockerOverrideFile, previous)
		rollbackErr := error(nil)
		if rollbackWriteErr == nil {
			rollbackErr = update.runCompose(ctx, *state)
		}
		if rollbackWriteErr != nil || rollbackErr != nil {
			return setFailure(update.store, state, "docker_update_and_rollback_failed", errors.New("the Docker update failed and automatic rollback also failed"))
		}
		return setFailure(update.store, state, "docker_update_failed", errors.New("the Docker update failed; the previous image was restored"))
	}
	state.CurrentVersion = state.AvailableVersion
	state.Status = "current"
	state.LastInstalledAt = update.now().UTC().Format(time.RFC3339Nano)
	state.DockerCurrentRef = next
	state.AvailableVersion = ""
	state.AvailableCritical = false
	state.RolloutEligible = false
	state.DownloadRequested = false
	state.InstallRequested = false
	state.Target = nil
	return update.store.save(*state)
}
