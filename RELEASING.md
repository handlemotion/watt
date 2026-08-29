# Releasing Watt for macOS

Stable releases are signed, notarized Apple Silicon DMGs produced from existing `vMAJOR.MINOR.PATCH` tags by the `Release` GitHub Actions workflow. Do not build or upload release assets by hand.

## One-time repository setup

Apple credentials are fetched directly from Infisical at runtime with GitHub OIDC. They are not copied into GitHub Secrets or synchronized into the repository.

### Infisical

The production setup uses the dedicated `Watt Release` project (`watt-release`), its `Release` environment (`release`), and the `/apple-notarization` folder. The `watt-github-release` machine identity has no organization access and is a read-only `viewer` of this project only. Infisical custom project roles require an Enterprise plan, so project isolation is what keeps the built-in viewer role limited to these six Watt credentials.

The identity ID is `fc772fd2-5d39-41f0-b3c4-046de41e46e2`. It has OIDC authentication only, with a 10-minute token TTL, and uses this trust policy:

- Discovery URL and issuer: `https://token.actions.githubusercontent.com`
- Subject: `repo:handlemotion@203549640/watt@1349126790:environment:release`
- Audience: `https://github.com/handlemotion`
- Additional claims:
  - `repository_id`: `1349126790`
  - `repository_owner_id`: `203549640`
  - `event_name`: `push`
  - `ref_type`: `tag`
  - `workflow_ref`: `handlemotion/watt/.github/workflows/release.yml@refs/tags/v*.*.*`
  - `repository_visibility`: `public`
  - `runner_environment`: `github-hosted`

The immutable owner and repository IDs above are intentional. Infisical supports glob matching for claims, but keep every other value exact.

The dedicated project contains only:

- `APPLE_CERTIFICATE`: base64-encoded Developer ID Application PKCS #12 certificate
- `APPLE_CERTIFICATE_PASSWORD`: password for that PKCS #12 file
- `APPLE_SIGNING_IDENTITY`: full Developer ID Application identity
- `APPLE_API_ISSUER`: App Store Connect API issuer UUID
- `APPLE_API_KEY`: App Store Connect API key ID
- `APPLE_API_KEY_CONTENT`: complete contents of the API key `.p8` file

The Developer ID payload must be exported from a traditional RSA private key as a macOS-compatible PKCS #12 file; verify that importing it into an isolated keychain makes the full signing identity visible before replacing `APPLE_CERTIFICATE`. The workflow generates its temporary keychain password on the runner, so it is not an external secret. Do not add unrelated application secrets or another project membership to this identity.

### GitHub

The protected GitHub environment is named `release`. It requires approval from `handlemotion` and restricts deployments to tags matching `v*.*.*`. Self-review is currently allowed because this repository has no second collaborator; enabling prevention would make every release impossible to approve. Add a second reviewer before enabling prevention.

The configured non-secret environment variables are:

- `INFISICAL_IDENTITY_ID`: `fc772fd2-5d39-41f0-b3c4-046de41e46e2`
- `INFISICAL_PROJECT_SLUG`: `watt-release`
- `INFISICAL_ENV_SLUG`: `release`
- `INFISICAL_SECRET_PATH`: `/apple-notarization`
- `INFISICAL_DOMAIN`: `https://app.infisical.com`

No GitHub Actions secrets are required. The workflow's `id-token: write` permission lets the SHA-pinned Infisical action exchange a short-lived GitHub OIDC token for the narrowly scoped values. GitHub publication and artifact attestation use only the workflow's scoped `GITHUB_TOKEN`; no personal access token is required.

## Release a version

1. Update the root `package.json` version and `apps/desktop/src-tauri/Cargo.toml` package version to the same stable SemVer value. Run `pnpm install` if the lockfile changes.
2. Run the local acceptance checks on an Apple Silicon Mac:

   ```sh
   pnpm install --frozen-lockfile
   pnpm check
   pnpm check:rust
   pnpm desktop:sidecar
   pnpm desktop:sidecar:smoke
   pnpm release:check vX.Y.Z
   ```

3. Merge the version change to `main`, then create and push the exact tag from that commit:

   ```sh
   git tag -a vX.Y.Z -m "Watt vX.Y.Z"
   git push origin vX.Y.Z
   ```

The workflow repeats all checks from a frozen install before requesting credentials, fetches the Apple values from Infisical through OIDC, imports the certificate into a temporary keychain, signs and notarizes the app, staples and verifies the app and DMG, produces `Watt-vX.Y.Z-aarch64.dmg` plus its SHA-256 checksum, records a GitHub artifact attestation, and publishes a draft release only after every acceptance check succeeds.

## Failure recovery

The workflow always deletes its temporary certificate, API key, and keychain. If Infisical authentication fails, verify the protected environment was approved, the five environment variables above are present, and the identity subject/audience/claims match the values above. If certificate import fails, confirm the PKCS #12 payload forms `Developer ID Application: Rodrigo Jimenez (ZVGTVNUPVA)` in a fresh keychain; do not work around it by weakening signing checks. If a run fails before publication, fix the source, move or recreate the unpublished tag intentionally, and rerun it; an existing draft release for that exact tag may be safely reused and its assets replaced. Delete a stale draft manually if its generated notes need to be regenerated.

The workflow refuses to overwrite an already published release. Correct a published release with a new patch version and tag. Do not move a published tag or replace its assets.
