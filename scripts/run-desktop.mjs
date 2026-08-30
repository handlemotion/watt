import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidecar = path.join(
  root,
  "apps",
  "desktop",
  "binaries",
  "watt-desktop-sidecar-aarch64-apple-darwin",
);

if (!existsSync(sidecar)) {
  const sidecarBuild = spawnSync("pnpm", ["desktop:sidecar"], {
    cwd: root,
    stdio: "inherit",
  });
  if (sidecarBuild.status !== 0) {
    process.exit(sidecarBuild.status ?? 1);
  }
}

const result = spawnSync(
  "cargo",
  [
    "run",
    "--manifest-path",
    "apps/desktop/Cargo.toml",
    ...process.argv.slice(2),
  ],
  { cwd: root, stdio: "inherit" },
);
process.exit(result.status ?? 1);
