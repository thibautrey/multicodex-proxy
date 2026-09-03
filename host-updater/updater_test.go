package main

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func testStore(t *testing.T) stateStore {
	t.Helper()
	directory := t.TempDir()
	cache := filepath.Join(directory, "updates")
	if err := os.Mkdir(cache, 0o700); err != nil {
		t.Fatal(err)
	}
	return stateStore{directory: directory, path: filepath.Join(directory, "state.json"), cache: cache, log: filepath.Join(directory, "update.log")}
}

func TestNotModifiedFeedRestoresDownloadedState(t *testing.T) {
	store := testStore(t)
	download := filepath.Join(store.cache, "multivibe-host_1.2.3.tar.gz")
	if err := os.WriteFile(download, []byte("archive"), 0o600); err != nil {
		t.Fatal(err)
	}
	state, err := defaultState("1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	state.Status = "downloaded"
	state.FeedETag = `"feed"`
	state.AvailableVersion = "1.2.3"
	state.RolloutEligible = true
	state.DownloadedPath = download
	state.DownloadedSHA256 = "a"
	state.Target = &updateTarget{Kind: "archive", Size: 7, SHA256: "a"}
	if err := store.save(state); err != nil {
		t.Fatal(err)
	}
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Header.Get("If-None-Match") != `"feed"` {
			t.Fatalf("missing conditional feed request")
		}
		return &http.Response{StatusCode: http.StatusNotModified, Header: make(http.Header), Body: http.NoBody}, nil
	})}
	update := updater{store: store, httpClient: client, now: func() time.Time { return time.Date(2026, 9, 3, 12, 0, 0, 0, time.UTC) }}
	if err := update.check(context.Background(), &state, true); err != nil {
		t.Fatal(err)
	}
	if state.Status != "downloaded" || state.DownloadedPath != download {
		t.Fatalf("downloaded state was not restored: %#v", state)
	}
}

func TestRequestApplyIsPersistedForTheSeparateScheduler(t *testing.T) {
	store := testStore(t)
	state, err := defaultState("1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	state.Status = "available"
	state.AvailableVersion = "1.2.3"
	state.RolloutEligible = true
	state.Target = &updateTarget{Kind: "archive", Size: 7, SHA256: "a"}
	update := updater{store: store}
	if err := requestOperation(&update, &state, true); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.load("1.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if !loaded.DownloadRequested || !loaded.InstallRequested {
		t.Fatalf("manual installation request was not persisted: %#v", loaded)
	}
}

func TestMissingCachedDownloadIsNotPreserved(t *testing.T) {
	target := updateTarget{Kind: "archive", Size: 7, SHA256: "a"}
	if downloadLooksPresent(filepath.Join(t.TempDir(), "missing.tar.gz"), target.Size) {
		t.Fatal("missing cached download was accepted")
	}
}
