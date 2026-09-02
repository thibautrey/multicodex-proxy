# Immutable Core source releases

Core source releases use annotated tags in the separate `source-v*` namespace;
they never invoke the Provider Host `v*` workflow or its Apple/GPG credentials.
The workflow archives the exact tagged commit with stable gzip metadata, checks
that `LICENSE`, `NOTICE`, and the bounded distribution decision are committed,
publishes SHA-256 digests, and creates GitHub OIDC/Sigstore build-provenance
attestations for every release subject.

Annotated-tag identity is verified against the GitHub Git Database API rather
than checkout's local tag ref, because checkout may represent an annotated tag
as its peeled commit. `source-v0.2.0` is retained unchanged as the historical
failed attempt; the corrected release starts at `source-v0.2.1`.

Push the reviewed release commit, then create and push an annotated tag pointing
exactly to it. Do not reuse or move a published tag. After the workflow
succeeds, download the release and verify each subject with
`gh attestation verify --repo thibautrey/multivibe --signer-workflow
thibautrey/multivibe/.github/workflows/source-release.yml --source-digest SHA
--source-ref refs/tags/TAG --deny-self-hosted-runners`, substituting the exact
reviewed 40-hex commit and immutable source tag.

The generated approval records the triggering GitHub actor, repository,
commit, tag, workflow run and attempt, UTC, archive digest, decision-record
digest, exact source scope, and exclusions. It records only the repository
owner's explicit Apache-2.0 distribution decision; it is not a statement of
legal, fiscal, tax, accounting, trademark, model-weight, third-party-license,
or Cloud-source approval.
