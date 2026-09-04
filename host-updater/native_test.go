package main

import (
	"archive/tar"
	"archive/zip"
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

func writeWindowsZipFixture(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fixture.zip")
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	directory := &zip.FileHeader{Name: "multivibe-host_1.0.0_windows_amd64/"}
	directory.SetMode(os.ModeDir | 0o700)
	if _, err := writer.CreateHeader(directory); err != nil {
		t.Fatal(err)
	}
	installer := &zip.FileHeader{Name: "multivibe-host_1.0.0_windows_amd64/install.ps1"}
	installer.SetMode(0o600)
	entry, err := writer.CreateHeader(installer)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := entry.Write([]byte("Write-Output ready\n")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestSafeWindowsArchivePath(t *testing.T) {
	tests := map[string]bool{
		"multivibe-host_1.0.0_windows_amd64/":            true,
		"multivibe-host_1.0.0_windows_amd64/install.ps1": true,
		"":                                     false,
		"/install.ps1":                         false,
		"multivibe-host_1.0.0_windows_amd64//": false,
		"multivibe-host_1.0.0_windows_amd64/../escape": false,
		"multivibe-host_1.0.0_windows_amd64\\escape":   false,
		"C:/escape": false,
		"multivibe-host_1.0.0_windows_amd64/./install.ps1": false,
	}
	for name, expected := range tests {
		if actual := safeWindowsArchivePath(name); actual != expected {
			t.Errorf("safeWindowsArchivePath(%q) = %v, want %v", name, actual, expected)
		}
	}
}

func TestExtractWindowsArchiveAllowsDirectoryEntries(t *testing.T) {
	destination := t.TempDir()
	root, err := extractWindowsArchive(writeWindowsZipFixture(t), destination)
	if err != nil || filepath.Base(root) != "multivibe-host_1.0.0_windows_amd64" {
		t.Fatalf("valid Windows archive failed: %q %v", root, err)
	}
	contents, err := os.ReadFile(filepath.Join(root, "install.ps1"))
	if err != nil || string(contents) != "Write-Output ready\n" {
		t.Fatalf("staged installer is invalid: %q %v", contents, err)
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
