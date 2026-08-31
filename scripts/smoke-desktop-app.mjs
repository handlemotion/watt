import { mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = process.env.WATT_DESKTOP_TARGET ?? "aarch64-apple-darwin";
const executable = path.join(
  root,
  "apps",
  "desktop",
  "dist",
  target,
  "Watt.app",
  "Contents",
  "MacOS",
  "watt-desktop",
);
const temporary = mkdtempSync(path.join(tmpdir(), "watt-desktop-smoke-"));
try {
  for (const smoke of [
    {
      argument: "--host-smoke",
      expected: "desktop Host handshake and graceful shutdown passed.",
    },
    {
      argument: "--window-smoke",
      expected: "desktop window startup and graceful shutdown passed.",
    },
  ]) {
    const result = spawnSync(executable, [smoke.argument], {
      encoding: "utf8",
      env: { ...process.env, WATT_APP_DATA_DIR: temporary },
      timeout: 30_000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(
        `desktop smoke test failed (${result.status}): ${result.stderr.trim()}`,
      );
    if (!result.stdout.includes(smoke.expected)) {
      throw new Error(
        `desktop smoke test returned unexpected output: ${result.stdout.trim()}`,
      );
    }
    process.stdout.write(result.stdout);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
