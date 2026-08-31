import { chmodSync, copyFileSync, cpSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.env.WATT_DESKTOP_TARGET ?? "aarch64-apple-darwin";
const app = path.join(root, "apps", "desktop", "dist", target, "Watt.app");
const tauriApp = path.join(
  root,
  "apps",
  "desktop",
  "src-tauri",
  "target",
  target,
  "release",
  "bundle",
  "macos",
  "Watt.app",
);
const sidecar = path.join(
  root,
  "apps",
  "desktop",
  "src-tauri",
  "binaries",
  "watt-desktop-sidecar-aarch64-apple-darwin",
);
const identity = process.env.APPLE_SIGNING_IDENTITY ?? "-";

rmSync(app, { recursive: true, force: true });
mkdirSync(path.dirname(app), { recursive: true });
cpSync(tauriApp, app, { recursive: true });

const macos = path.join(app, "Contents", "MacOS");
copyFileSync(sidecar, path.join(macos, "watt-desktop-sidecar"));
chmodSync(path.join(macos, "watt-desktop"), 0o755);
chmodSync(path.join(macos, "watt-desktop-sidecar"), 0o755);

function codesign(targetPath, entitlements) {
  const args = ["--force", "--options", "runtime"];
  if (identity !== "-") args.push("--timestamp");
  if (entitlements) args.push("--entitlements", entitlements);
  args.push("--sign", identity, targetPath);
  const result = spawnSync("codesign", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`codesign failed for ${targetPath}`);
}

codesign(
  path.join(macos, "watt-desktop-sidecar"),
  path.join(root, "apps", "desktop", "src-tauri", "sidecar.entitlements.plist"),
);
codesign(path.join(macos, "watt-desktop"));
codesign(app);
const verify = spawnSync(
  "codesign",
  ["--verify", "--deep", "--strict", "--verbose=2", app],
  { stdio: "inherit" },
);
if (verify.error) throw verify.error;
if (verify.status !== 0)
  throw new Error("packaged application signature verification failed");
console.log(`Desktop app: ${path.relative(root, app)}`);
