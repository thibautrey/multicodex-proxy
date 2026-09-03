package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func fatal(message string) {
	fmt.Fprintln(os.Stderr, "multivibe-host-updater:", message)
	os.Exit(2)
}

func usage() {
	fmt.Fprintln(os.Stderr, `usage: multivibe-host-updater <command>

Commands:
  version
  status
  check
  download
  apply
  request-download
  request-apply
  auto
  configure --mode <automatic|download|notify> --channel <stable|beta>
  docker-configure --compose-file <absolute-path> --project-directory <absolute-path>
  docker-auto`)
}

func configure(state *updaterState, arguments []string) error {
	for len(arguments) > 0 {
		if len(arguments) < 2 {
			return errors.New("configure options require values")
		}
		switch arguments[0] {
		case "--mode":
			if arguments[1] != "automatic" && arguments[1] != "download" && arguments[1] != "notify" {
				return errors.New("update mode is invalid")
			}
			state.Mode = arguments[1]
		case "--channel":
			if arguments[1] != "stable" && arguments[1] != "beta" {
				return errors.New("update channel is invalid")
			}
			if state.Channel != arguments[1] {
				state.FeedETag = ""
				state.AvailableVersion = ""
				state.AvailableCritical = false
				state.RolloutEligible = false
				state.DownloadedPath = ""
				state.DownloadedSHA256 = ""
				state.DownloadRequested = false
				state.InstallRequested = false
				state.Target = nil
				state.Status = "idle"
			}
			state.Channel = arguments[1]
			state.NextCheckAt = ""
		default:
			return fmt.Errorf("unknown configure option: %s", arguments[0])
		}
		arguments = arguments[2:]
	}
	return nil
}

func dockerConfigureArguments(arguments []string) (string, string, error) {
	var compose, project string
	for len(arguments) > 0 {
		if len(arguments) < 2 {
			return "", "", errors.New("docker-configure options require values")
		}
		switch arguments[0] {
		case "--compose-file":
			compose = arguments[1]
		case "--project-directory":
			project = arguments[1]
		default:
			return "", "", fmt.Errorf("unknown docker-configure option: %s", arguments[0])
		}
		arguments = arguments[2:]
	}
	if compose == "" || project == "" {
		return "", "", errors.New("docker-configure requires --compose-file and --project-directory")
	}
	return compose, project, nil
}

func runAutomatic(ctx context.Context, update *updater, state *updaterState) error {
	if err := update.check(ctx, state, false); err != nil {
		return err
	}
	if state.Status != "available" && state.Status != "downloaded" {
		return nil
	}
	installRequested := state.InstallRequested
	downloadRequested := state.DownloadRequested || installRequested
	if state.Mode == "notify" && !downloadRequested {
		return nil
	}
	if !update.container {
		if state.DownloadedPath == "" {
			if err := update.download(ctx, state); err != nil {
				return err
			}
		}
		if (state.Mode == "download" || state.Mode == "notify") && !installRequested {
			return nil
		}
		return update.applyNative(ctx, state)
	}
	if state.Mode != "automatic" && !installRequested {
		return nil
	}
	return update.applyDocker(ctx, state)
}

func requestOperation(update *updater, state *updaterState, install bool) error {
	if state.Target == nil || state.AvailableVersion == "" || !state.RolloutEligible {
		return errors.New("no eligible update is available")
	}
	if update.container {
		return errors.New("container updates are managed by the host-side Docker updater")
	}
	state.DownloadRequested = true
	if install {
		state.InstallRequested = true
	}
	return update.store.save(*state)
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	command := os.Args[1]
	container := command == "docker-auto" || command == "docker-configure"
	if command == "version" {
		fmt.Fprintln(os.Stdout, hostUpdaterVersion)
		return
	}
	update, state, err := newUpdater(container)
	if err != nil {
		fatal(err.Error())
	}
	if command != "status" {
		unlock, lockErr := update.store.lock()
		if lockErr != nil {
			fatal(lockErr.Error())
		}
		defer unlock()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Minute)
	defer cancel()
	switch command {
	case "status":
		err = encodePublicStatus(state)
	case "check":
		if len(os.Args) != 2 {
			err = errors.New("check does not accept arguments")
		} else {
			err = update.check(ctx, &state, true)
		}
		if err == nil {
			err = encodePublicStatus(state)
		}
	case "download":
		if len(os.Args) != 2 {
			err = errors.New("download does not accept arguments")
		} else {
			err = update.download(ctx, &state)
		}
		if err == nil {
			err = encodePublicStatus(state)
		}
	case "apply":
		if len(os.Args) != 2 {
			err = errors.New("apply does not accept arguments")
		} else {
			err = update.applyNative(ctx, &state)
		}
	case "request-download", "request-apply":
		if len(os.Args) != 2 {
			err = errors.New(command + " does not accept arguments")
		} else {
			err = requestOperation(update, &state, command == "request-apply")
		}
		if err == nil {
			err = encodePublicStatus(state)
		}
	case "auto", "docker-auto":
		if len(os.Args) != 2 {
			err = errors.New(command + " does not accept arguments")
		} else {
			err = runAutomatic(ctx, update, &state)
		}
	case "configure":
		err = configure(&state, os.Args[2:])
		if err == nil {
			err = update.store.save(state)
		}
		if err == nil {
			err = encodePublicStatus(state)
		}
	case "docker-configure":
		var compose, project string
		compose, project, err = dockerConfigureArguments(os.Args[2:])
		if err == nil {
			err = update.configureDocker(&state, filepath.Clean(compose), filepath.Clean(project))
		}
		if err == nil {
			err = encodePublicStatus(state)
		}
	default:
		usage()
		err = errors.New("unknown command: " + command)
	}
	if err != nil {
		message := strings.TrimSpace(err.Error())
		if encoded, encodeErr := json.Marshal(map[string]string{"error": message}); encodeErr == nil {
			fmt.Fprintln(os.Stderr, string(encoded))
		}
		os.Exit(1)
	}
}
