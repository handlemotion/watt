# Releasing Watt for macOS

Stable releases are signed, notarized Apple Silicon DMGs produced by the `Release` GitHub Actions workflow when a **Version Packages** PR merges. Do not bump versions or upload release assets by hand.

## One-time repository setup

Apple credentials are fetched directly from Infisical at runtime with GitHub OIDC. They are not copied into GitHub Secrets or synchronized into the repository.

### Infisical

The production setup uses the dedicated `Watt Release` project (`watt-release`), its `Release` environment (`release`), and the `/apple-notarization` folder. The `watt-github-release` machine identity has no organization access and is a read-only `viewer` of this project only. Infisical custom project roles require an Enterprise plan, so project isolation is what keeps the built-in viewer role limited to these six Watt credentials.

The identity ID is `fc772fd2-5d39-41f0-b3c4-046de41e46e2`. It has OIDC authentication only, with a 10-minute token TTL, and uses this shared trust policy:

- Discovery URL and issuer: `https://token.actions.githubusercontent.com`
- Subject: `repo:handlemotion@203549640/watt@1349126790:environment:release`
- Audience: `https://github.com/handlemotion`
- Additional claims shared by both release paths:
  - `repository_id`: `1349126790`
  - `repository_owner_id`: `203549640`
  - `event_name`: `push`
  - `repository_visibility`: `public`
  - `runner_environment`: `github-hosted`

Packaging runs on `main` after a Version Packages merge. Keep a second, otherwise identical trust policy for tag recovery (`v*.*.*`). The two policies differ only in these claims:

| Path                   | `ref_type` | `workflow_ref`                                                     |
| ---------------------- | ---------- | ------------------------------------------------------------------ |
| Version Packages merge | `branch`   | `handlemotion/watt/.github/workflows/release.yml@refs/heads/main`  |
| Tag recovery           | `tag`      | `handlemotion/watt/.github/workflows/release.yml@refs/tags/v*.*.*` |

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

The protected GitHub environment is named `release`. It requires approval from `handlemotion` and allows deployments from `main` and from tags matching `v*.*.*`. Self-review is currently allowed because this repository has no second collaborator; enabling prevention would make every release impossible to approve. Add a second reviewer before enabling prevention.

In **Settings → Actions → General**, enable **Allow GitHub Actions to create and approve pull requests** so the Version Packages PR can be opened.

The configured non-secret environment variables are:

- `INFISICAL_IDENTITY_ID`: `fc772fd2-5d39-41f0-b3c4-046de41e46e2`
- `INFISICAL_PROJECT_SLUG`: `watt-release`
- `INFISICAL_ENV_SLUG`: `release`
- `INFISICAL_SECRET_PATH`: `/apple-notarization`
- `INFISICAL_DOMAIN`: `https://app.infisical.com`

No GitHub Actions secrets are required. The workflow's `id-token: write` permission lets the SHA-pinned Infisical action exchange a short-lived GitHub OIDC token for the narrowly scoped values. GitHub publication and artifact attestation use only the workflow's scoped `GITHUB_TOKEN`; no personal access token is required.

## Release a version

1. In the PR that should ship, add a changeset (`pnpm changeset`). Watt versions Host, CLI, sidecar, and desktop together; choose patch or minor unless you are intentionally shipping a breaking change.
2. Merge that PR to `main`. The Release workflow opens or updates a **Version Packages** PR with changelog and version bumps, including the root `package.json` and `apps/desktop/Cargo.toml`.
3. Merge **Version Packages**. That merge is what starts signed packaging CI. Optional local acceptance on an Apple Silicon Mac before merging:

   ```sh
   pnpm install --frozen-lockfile
   pnpm check
   pnpm check:rust
   pnpm desktop:sidecar
   pnpm desktop:sidecar:smoke
   cargo build --manifest-path apps/desktop/Cargo.toml --release --target aarch64-apple-darwin
   pnpm desktop:bundle
   pnpm desktop:app:smoke
   pnpm desktop:dmg
   hdiutil verify apps/desktop/dist/aarch64-apple-darwin/Watt-aarch64.dmg
   pnpm release:check vX.Y.Z
   ```

The workflow repeats all checks from a frozen install before requesting credentials, fetches the Apple values from Infisical through OIDC, imports the certificate into a temporary keychain, builds the GPUI executable, packages and signs the app explicitly, runs the packaged GPUI-to-Host lifecycle probe, notarizes and staples the app and DMG, produces `Watt-vX.Y.Z-aarch64.dmg` plus its SHA-256 checksum, records a GitHub artifact attestation, creates `vX.Y.Z` if needed, and publishes a draft release only after every acceptance check succeeds.

Pushing an unpublished `vMAJOR.MINOR.PATCH` tag remains a recovery path if the `main` packaging job did not run.

## Failure recovery

The workflow always deletes its temporary certificate, API key, and keychain. If Infisical authentication fails, verify the protected environment was approved, the five environment variables above are present, and the identity subject/audience/claims match the values above (including the `main` trust policy). If certificate import fails, confirm the PKCS #12 payload forms `Developer ID Application: Rodrigo Jimenez (ZVGTVNUPVA)` in a fresh keychain; do not work around it by weakening signing checks. If a run fails before publication, fix the source, add a patch changeset if versions already landed, and merge again; an existing draft release for that exact tag may be safely reused and its assets replaced. Delete a stale draft manually if its generated notes need to be regenerated.

The workflow skips packaging when a published GitHub Release already exists for that version. Correct a published release with a new patch changeset. Do not move a published tag or replace its assets.
