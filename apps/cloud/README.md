# Watt cloud API

This Hono Worker is Watt's authenticated personal-cloud control plane. It keeps identity and routing metadata in PlanetScale Postgres through Hyperdrive, serializes each owner's Upstash Box lifecycle in `CloudHostCoordinator`, and streams the cloud daemon's persisted run events without buffering.

## Provisioning

Create separate PlanetScale databases and Cloudflare Hyperdrive configurations for staging and production. Replace the placeholder Hyperdrive IDs, immutable GitHub owner ID, daemon release tarball URL and SHA-256, auth URLs, and native callback in `wrangler.jsonc` for each environment.

Configure one GitHub App for user authorization and selected-repository installation. Its callback is `<BETTER_AUTH_URL>/api/auth/callback/github`; grant repository metadata read and contents read/write only. Configure the native OAuth callback as the fixed localhost URI in `NATIVE_REDIRECT_URI`.

Set these Worker secrets independently in staging and production:

```sh
pnpm exec wrangler secret put BETTER_AUTH_SECRET --env staging
pnpm exec wrangler secret put BETTER_AUTH_URL --env staging
pnpm exec wrangler secret put GITHUB_CLIENT_ID --env staging
pnpm exec wrangler secret put GITHUB_CLIENT_SECRET --env staging
pnpm exec wrangler secret put GITHUB_APP_ID --env staging
pnpm exec wrangler secret put GITHUB_APP_PRIVATE_KEY --env staging
pnpm exec wrangler secret put GITHUB_WEBHOOK_SECRET --env staging
pnpm exec wrangler secret put UPSTASH_BOX_API_KEY --env staging
pnpm exec wrangler secret put CLOUD_DAEMON_TOKEN --env staging
pnpm exec wrangler secret put CURSOR_API_KEY --env staging
```

Repeat with `--env production` only after staging passes. Secrets never belong in Wrangler variables, PlanetScale, the repository, or the persistent box filesystem.

## Generated artifacts and checks

Better Auth and Drizzle own schema generation:

```sh
pnpm --filter @watt/cloud-api auth:generate
pnpm --filter @watt/cloud-api db:generate
pnpm --filter @watt/cloud-api db:check
```

Review the generated SQL, then apply it with the environment's direct PlanetScale Postgres URL before deploying the corresponding Worker. Do not point migration tooling at Hyperdrive.

```sh
WATT_PLANETSCALE_DATABASE_URL=... pnpm --filter @watt/cloud-api db:migrate
pnpm --filter @watt/cloud-api cf-typegen
pnpm --filter @watt/cloud-api test
pnpm --filter @watt/cloud-api build
pnpm --filter @watt/cloud-api startup:check
```

Build and publish the immutable Linux daemon tarball from `packages/cloud-daemon` before a Worker deployment:

```sh
pnpm --filter @watt/cloud-daemon package:linux
pnpm --filter @watt/cloud-daemon smoke:linux
```

Point `CLOUD_DAEMON_TARBALL_URL` and `CLOUD_DAEMON_TARBALL_SHA256` at the published GitHub Release asset.

## Rollout

Deploy staging first:

```sh
pnpm --filter @watt/cloud-api deploy -- --env staging
```

Run the opt-in provider smoke with a short-lived native access token and an exact pushed test commit. The smoke intentionally takes more than 18 minutes: it holds a run beyond the eight-minute idle policy, disconnects and reattaches, verifies publication, observes pause, wakes the box, and verifies persisted event replay.

```sh
WATT_CLOUD_API_URL=https://staging.example \
WATT_CLOUD_ACCESS_TOKEN=... \
WATT_GITHUB_REPOSITORY_ID=... \
WATT_GITHUB_INSTALLATION_ID=... \
WATT_SMOKE_BASE_SHA=... \
pnpm --filter @watt/cloud-api smoke:provider
```

Apply the reviewed production migration and deploy `--env production` only after the staging smoke succeeds.
