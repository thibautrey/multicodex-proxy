package main

import (
	"archive/tar"
	"compress/gzip"
	"os"
	"path/filepath"
	"testing"
)

func writeTarFixture(t *testing.T, name string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fixture.tar.gz")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	gzipWriter := gzip.NewWriter(file)
	tarWriter := tar.NewWriter(gzipWriter)
	contents := []byte("#!/bin/sh\n")
	if err := tarWriter.WriteHeader(&tar.Header{Name: name, Mode: 0o555, Size: int64(len(contents)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tarWriter.Write(contents); err != nil {
		t.Fatal(err)
	}
	if err := tarWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gzipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestExtractLinuxArchive(t *testing.T) {
	root, err := extractLinuxArchive(writeTarFixture(t, "multivibe-host_1.0.0/install.sh"), t.TempDir())
	if err != nil || filepath.Base(root) != "multivibe-host_1.0.0" {
		t.Fatalf("valid archive failed: %q %v", root, err)
	}
}

func TestExtractLinuxArchiveRejectsTraversal(t *testing.T) {
	if _, err := extractLinuxArchive(writeTarFixture(t, "../install.sh"), t.TempDir()); err == nil {
		t.Fatal("archive traversal accepted")
	}
}

func TestWriteDockerOverride(t *testing.T) {
	path := filepath.Join(t.TempDir(), "override.yml")
	reference := "ghcr.io/thibautrey/multivibe-host@sha256:" + string(make([]byte, 64))
	// NUL bytes must fail the strict canonical image reference.
	if err := writeDockerOverride(path, reference); err == nil {
		t.Fatal("invalid Docker reference accepted")
	}
	valid := "ghcr.io/thibautrey/multivibe-host@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if err := writeDockerOverride(path, valid); err != nil {
		t.Fatal(err)
	}
	contents, _ := os.ReadFile(path)
	if string(contents) != "# Managed by MultiVibe Host updater\nservices:\n  multivibe-host:\n    image: "+valid+"\n" {
		t.Fatalf("unexpected override: %q", contents)
	}
}
