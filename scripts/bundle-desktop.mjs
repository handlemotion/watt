import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
);
const target = process.env.WATT_DESKTOP_TARGET ?? "aarch64-apple-darwin";
const app = path.join(root, "apps", "desktop", "dist", target, "Watt.app");
const contents = path.join(app, "Contents");
const macos = path.join(contents, "MacOS");
const resources = path.join(contents, "Resources");
const desktop = path.join(
  root,
  "apps",
  "desktop",
  "target",
  target,
  "release",
  "watt-desktop",
);
const sidecar = path.join(
  root,
  "apps",
  "desktop",
  "binaries",
  "watt-desktop-sidecar-aarch64-apple-darwin",
);
const identity = process.env.APPLE_SIGNING_IDENTITY ?? "-";

rmSync(app, { recursive: true, force: true });
mkdirSync(macos, { recursive: true });
mkdirSync(resources, { recursive: true });
copyFileSync(desktop, path.join(macos, "watt-desktop"));
copyFileSync(sidecar, path.join(macos, "watt-desktop-sidecar"));
copyFileSync(
  path.join(root, "apps", "desktop", "assets", "icon.icns"),
  path.join(resources, "icon.icns"),
);
chmodSync(path.join(macos, "watt-desktop"), 0o755);
chmodSync(path.join(macos, "watt-desktop-sidecar"), 0o755);
const plist = readFileSync(
  path.join(root, "apps", "desktop", "Info.plist.in"),
  "utf8",
).replaceAll("__WATT_VERSION__", manifest.version);
writeFileSync(path.join(contents, "Info.plist"), plist);

function codesign(targetPath, entitlements) {
  const args = ["--force"];
  if (identity !== "-") args.push("--options", "runtime", "--timestamp");
  if (entitlements) args.push("--entitlements", entitlements);
  args.push("--sign", identity, targetPath);
  const result = spawnSync("codesign", args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`codesign failed for ${targetPath}`);
}

codesign(
  path.join(macos, "watt-desktop-sidecar"),
  path.join(root, "apps", "desktop", "sidecar.entitlements.plist"),
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
