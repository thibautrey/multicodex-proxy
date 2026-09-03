package main

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func verifyDownloadedArchive(state updaterState) error {
	if state.DownloadedPath == "" || state.Target == nil || state.DownloadedSHA256 != state.Target.SHA256 {
		return errors.New("no verified downloaded update is available")
	}
	info, err := os.Lstat(state.DownloadedPath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() != state.Target.Size {
		return errors.New("the downloaded update archive is unavailable")
	}
	file, err := os.Open(state.DownloadedPath)
	if err != nil {
		return errors.New("the downloaded update archive cannot be opened")
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil || hex.EncodeToString(digest.Sum(nil)) != state.Target.SHA256 {
		return errors.New("the downloaded update archive changed after verification")
	}
	return nil
}

func cleanArchivePath(root, name string) (string, error) {
	if name == "" || strings.ContainsRune(name, '\x00') || filepath.IsAbs(name) || filepath.Clean(name) != name || name == "." || strings.HasPrefix(name, ".."+string(filepath.Separator)) {
		return "", errors.New("the update archive contains an unsafe path")
	}
	destination := filepath.Join(root, filepath.FromSlash(name))
	relative, err := filepath.Rel(root, destination)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("the update archive escapes its staging directory")
	}
	return destination, nil
}

func extractLinuxArchive(archive, destination string) (string, error) {
	file, err := os.Open(archive)
	if err != nil {
		return "", err
	}
	defer file.Close()
	compressed, err := gzip.NewReader(file)
	if err != nil {
		return "", errors.New("the Linux update is not a gzip archive")
	}
	defer compressed.Close()
	reader := tar.NewReader(compressed)
	var rootName string
	var total int64
	entries := 0
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return "", errors.New("the Linux update archive is invalid")
		}
		entries++
		if entries > 200000 || header.Size < 0 || header.Size > maximumArtifactBytes {
			return "", errors.New("the Linux update archive exceeds its safety bounds")
		}
		entryName := header.Name
		if header.Typeflag == tar.TypeDir {
			entryName = strings.TrimSuffix(entryName, "/")
		}
		parts := strings.Split(filepath.ToSlash(entryName), "/")
		if len(parts) == 0 || parts[0] == "" {
			return "", errors.New("the Linux update archive root is invalid")
		}
		if rootName == "" {
			rootName = parts[0]
		}
		if parts[0] != rootName {
			return "", errors.New("the Linux update archive has multiple roots")
		}
		target, err := cleanArchivePath(destination, entryName)
		if err != nil {
			return "", err
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return "", err
			}
		case tar.TypeReg, tar.TypeRegA:
			total += header.Size
			if total > maximumArtifactBytes {
				return "", errors.New("the Linux update archive expands beyond its safety bound")
			}
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return "", err
			}
			mode := os.FileMode(header.Mode) & 0o777
			if mode&0o002 != 0 {
				return "", errors.New("the Linux update archive contains a world-writable file")
			}
			output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
			if err != nil {
				return "", err
			}
			written, copyErr := io.CopyN(output, reader, header.Size)
			closeErr := output.Close()
			if copyErr != nil || closeErr != nil || written != header.Size {
				return "", errors.New("the Linux update archive could not be extracted completely")
			}
		default:
			return "", errors.New("the Linux update archive contains links or unsupported entries")
		}
	}
	if rootName == "" {
		return "", errors.New("the Linux update archive is empty")
	}
	root := filepath.Join(destination, rootName)
	installer := filepath.Join(root, "install.sh")
	info, err := os.Lstat(installer)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o111 == 0 {
		return "", errors.New("the Linux update installer is unavailable")
	}
	return root, nil
}

type hostCredentials struct {
	SchemaVersion string `json:"schema_version"`
	AdminToken    string `json:"admin_token"`
}

func (update *updater) hostRequest(ctx context.Context, method, route string) (*http.Response, error) {
	credentialPath := filepath.Join(update.store.directory, "host-credentials.json")
	info, err := os.Lstat(credentialPath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o600 || info.Size() > 16*1024 {
		return nil, errors.New("the local Host credentials are unavailable")
	}
	data, err := os.ReadFile(credentialPath)
	if err != nil {
		return nil, errors.New("the local Host credentials cannot be read")
	}
	var credentials hostCredentials
	if decodeStrictJSON(data, &credentials) != nil || credentials.SchemaVersion != "multivibe-host-credentials-v1" || len(credentials.AdminToken) < 32 {
		return nil, errors.New("the local Host credentials are invalid")
	}
	port := strings.TrimSpace(os.Getenv("MULTIVIBE_HOST_PORT"))
	if port == "" {
		port = "1455"
	}
	request, err := http.NewRequestWithContext(ctx, method, "http://127.0.0.1:"+port+route, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("x-admin-token", credentials.AdminToken)
	request.Header.Set("accept", "application/json")
	return (&http.Client{Timeout: 5 * time.Second}).Do(request)
}

func (update *updater) drain(ctx context.Context) error {
	response, err := update.hostRequest(ctx, http.MethodPost, "/admin/host-update/drain")
	if err != nil {
		return errors.New("the running Host could not enter update drain mode")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("the Host refused update drain mode with HTTP %d", response.StatusCode)
	}
	deadline := update.now().Add(5 * time.Minute)
	for update.now().Before(deadline) {
		response, err := update.hostRequest(ctx, http.MethodGet, "/admin/host-update/readiness")
		if err == nil {
			var result struct {
				Ready bool `json:"ready"`
			}
			decodeErr := json.NewDecoder(io.LimitReader(response.Body, 64*1024)).Decode(&result)
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK && decodeErr == nil && result.Ready {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
	return errors.New("the Host did not become idle before the update deadline")
}

func (update *updater) resumeDrain() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	response, err := update.hostRequest(ctx, http.MethodPost, "/admin/host-update/resume")
	if err == nil {
		_ = response.Body.Close()
	}
}

func commandWithLog(ctx context.Context, logPath, program string, arguments ...string) error {
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return errors.New("the update log cannot be opened")
	}
	defer logFile.Close()
	command := exec.CommandContext(ctx, program, arguments...)
	command.Stdin = nil
	command.Stdout = logFile
	command.Stderr = logFile
	command.Env = os.Environ()
	return command.Run()
}

func (update *updater) applyNative(ctx context.Context, state *updaterState) error {
	if err := verifyDownloadedArchive(*state); err != nil {
		return setFailure(update.store, state, "artifact_recheck_failed", err)
	}
	state.Status = "installing"
	state.LastError = ""
	state.LastErrorCode = ""
	if err := update.store.save(*state); err != nil {
		return err
	}
	if err := update.drain(ctx); err != nil {
		return setFailure(update.store, state, "host_not_idle", err)
	}
	installed := false
	defer func() {
		if !installed {
			update.resumeDrain()
		}
	}()
	var installErr error
	if runtime.GOOS == "linux" {
		staging, err := os.MkdirTemp(update.store.cache, ".extract-*")
		if err != nil {
			return setFailure(update.store, state, "extract_stage_failed", err)
		}
		defer os.RemoveAll(staging)
		root, err := extractLinuxArchive(state.DownloadedPath, staging)
		if err != nil {
			return setFailure(update.store, state, "archive_extract_failed", err)
		}
		installErr = commandWithLog(ctx, update.store.log, filepath.Join(root, "install.sh"), "--automatic-update")
	} else if runtime.GOOS == "darwin" {
		mountRoot, err := os.MkdirTemp(update.store.cache, ".mount-*")
		if err != nil {
			return setFailure(update.store, state, "mount_stage_failed", err)
		}
		defer os.RemoveAll(mountRoot)
		mountPoint := filepath.Join(mountRoot, "volume")
		if err := os.Mkdir(mountPoint, 0o700); err != nil {
			return setFailure(update.store, state, "mount_stage_failed", err)
		}
		if err := commandWithLog(ctx, update.store.log, "/usr/bin/hdiutil", "attach", "-quiet", "-readonly", "-nobrowse", "-mountpoint", mountPoint, state.DownloadedPath); err != nil {
			return setFailure(update.store, state, "dmg_mount_failed", errors.New("the signed macOS disk image could not be mounted"))
		}
		defer func() {
			_ = commandWithLog(context.Background(), update.store.log, "/usr/bin/hdiutil", "detach", "-quiet", mountPoint)
		}()
		application := filepath.Join(mountPoint, "MultiVibe Host.app")
		installer := filepath.Join(application, "Contents", "Resources", "update", "install.sh")
		installErr = commandWithLog(ctx, update.store.log, installer, "--automatic-update", "--source-application", application)
	} else {
		installErr = errors.New("native updates are unsupported on this operating system")
	}
	if installErr != nil {
		return setFailure(update.store, state, "installation_failed", errors.New("the update installer failed and restored the previous Host"))
	}
	installed = true
	state.CurrentVersion = state.AvailableVersion
	state.Status = "current"
	state.LastInstalledAt = update.now().UTC().Format(time.RFC3339Nano)
	state.AvailableVersion = ""
	state.AvailableCritical = false
	state.RolloutEligible = false
	state.Target = nil
	state.DownloadedPath = ""
	state.DownloadedSHA256 = ""
	state.DownloadRequested = false
	state.InstallRequested = false
	if err := update.store.save(*state); err != nil {
		return err
	}
	if runtime.GOOS == "darwin" {
		_ = exec.Command("/usr/bin/open", filepath.Join(os.Getenv("HOME"), "Applications", "MultiVibe Host.app")).Start()
	}
	return nil
}
