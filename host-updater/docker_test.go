package main

import "testing"

func TestOfficialDockerRepoDigestSelectsImmutableReference(t *testing.T) {
	digest := "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	reference, err := officialDockerRepoDigest(`["docker.io/example/host@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","ghcr.io/thibautrey/multivibe-host@` + digest + `"]`)
	if err != nil {
		t.Fatal(err)
	}
	if reference != "ghcr.io/thibautrey/multivibe-host@"+digest {
		t.Fatalf("unexpected immutable reference: %s", reference)
	}
}

func TestOfficialDockerRepoDigestRejectsMutableOrForeignReferences(t *testing.T) {
	for _, encoded := range []string{
		`["ghcr.io/thibautrey/multivibe-host:latest"]`,
		`["docker.io/thibautrey/multivibe-host@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]`,
		`null`,
	} {
		if _, err := officialDockerRepoDigest(encoded); err == nil {
			t.Fatalf("invalid repository digest was accepted: %s", encoded)
		}
	}
}
