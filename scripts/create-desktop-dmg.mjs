import { cpSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.env.WATT_DESKTOP_TARGET ?? "aarch64-apple-darwin";
const dist = path.join(root, "apps", "desktop", "dist", target);
const app = path.join(dist, "Watt.app");
const staging = path.join(root, ".context", "desktop-dmg", target);
const dmg = path.join(dist, "Watt-aarch64.dmg");
rmSync(staging, { recursive: true, force: true });
rmSync(dmg, { force: true });
mkdirSync(staging, { recursive: true });
cpSync(app, path.join(staging, "Watt.app"), { recursive: true });
symlinkSync("/Applications", path.join(staging, "Applications"));
const result = spawnSync(
  "hdiutil",
  ["create", "-volname", "Watt", "-srcfolder", staging, "-ov", "-format", "UDZO", dmg],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error("DMG creation failed");
const identity = process.env.APPLE_SIGNING_IDENTITY ?? "-";
const signArgs = ["--force"];
if (identity !== "-") signArgs.push("--timestamp");
signArgs.push("--sign", identity, dmg);
const sign = spawnSync("codesign", signArgs, { stdio: "inherit" });
if (sign.error) throw sign.error;
if (sign.status !== 0) throw new Error("DMG signing failed");
console.log(`Desktop DMG: ${path.relative(root, dmg)}`);
