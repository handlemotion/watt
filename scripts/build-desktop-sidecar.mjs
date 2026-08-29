import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, "apps", "desktop", "binaries");
const output = path.join(
  outputDir,
  "watt-desktop-sidecar-aarch64-apple-darwin",
);
const buildDir = path.join(root, ".context", "desktop-sidecar-build");
const bundle = path.join(buildDir, "desktop-sidecar.cjs");
const pkgConfig = path.join(buildDir, "package.json");

if (platform !== "darwin" || arch !== "arm64") {
  throw new Error(
    `desktop sidecar must be built natively on macOS arm64 (received ${platform} ${arch})`,
  );
}

mkdirSync(outputDir, { recursive: true });
mkdirSync(buildDir, { recursive: true });

const bundleResult = spawnSync(
  "pnpm",
  [
    "exec",
    "esbuild",
    "packages/desktop-sidecar/dist/cli.js",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=node22",
    '--define:import.meta.url="file:///unused"',
    "--define:__WATT_PKG__=true",
    "--external:@cursor/sdk",
    "--external:better-sqlite3",
    `--outfile=${bundle}`,
  ],
  { cwd: root, stdio: "inherit" },
);
if (bundleResult.error) throw bundleResult.error;
if (bundleResult.status !== 0) {
  throw new Error(
    `desktop sidecar bundling failed with exit ${bundleResult.status}`,
  );
}

copyFileSync(
  path.join(root, "packages", "desktop-sidecar", "protocol.schema.json"),
  path.join(buildDir, "protocol.schema.json"),
);
writeFileSync(
  pkgConfig,
  `${JSON.stringify({ name: "watt-desktop-sidecar-bundle", version: "0.0.0", private: true, main: "desktop-sidecar.cjs", bin: "desktop-sidecar.cjs", pkg: { assets: ["protocol.schema.json", "../../node_modules/better-sqlite3/build/Release/better_sqlite3.node"] } }, null, 2)}\n`,
);

const result = spawnSync(
  "pnpm",
  [
    "exec",
    "pkg",
    buildDir,
    "--targets",
    "node22-macos-arm64",
    "--output",
    output,
    "--compress",
    "GZip",
    "--fallback-to-source",
  ],
  { cwd: root, stdio: "inherit" },
);

if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(
    `desktop sidecar packaging failed with exit ${result.status}`,
  );
}

console.log(`Desktop sidecar: ${path.relative(root, output)}`);
