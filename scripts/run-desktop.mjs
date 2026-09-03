import { existsSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktop = path.join(root, "apps", "desktop");
const sidecar = path.join(
  desktop,
  "src-tauri",
  "binaries",
  "watt-desktop-sidecar-aarch64-apple-darwin",
);
const tauriConf = JSON.parse(
  readFileSync(path.join(desktop, "src-tauri", "tauri.conf.json"), "utf8"),
);
const devPort = Number(new URL(tauriConf.build.devUrl).port);

function listeningPids(port) {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
    encoding: "utf8",
  });
  if (result.status !== 0 && result.status !== 1) {
    return [];
  }
  return [
    ...new Set(
      (result.stdout ?? "")
        .split(/\s+/)
        .map((pid) => pid.trim())
        .filter(Boolean),
    ),
  ];
}

function commandFor(pid) {
  return spawnSync("ps", ["-p", pid, "-o", "args="], {
    encoding: "utf8",
  }).stdout.trim();
}

function isDesktopVite(args) {
  const desktopMarker = `${path.sep}apps${path.sep}desktop${path.sep}`;
  return (
    args.includes(desktopMarker) &&
    (args.includes(`${path.sep}vite${path.sep}`) || args.includes("vite.js"))
  );
}

async function freeLeakedDesktopVite(port) {
  for (const pid of listeningPids(port)) {
    if (!isDesktopVite(commandFor(pid))) continue;
    try {
      process.kill(Number(pid), "SIGTERM");
    } catch {
      // already gone
    }
  }

  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const leftover = listeningPids(port).filter((pid) => isDesktopVite(commandFor(pid)));
    if (leftover.length === 0) return;
    await delay(50);
  }
}

function runTauriDev(args) {
  const child = spawn("pnpm", ["exec", "tauri", "dev", ...args], {
    cwd: desktop,
    stdio: "inherit",
  });

  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);

  return new Promise((resolve) => {
    child.on("exit", (code, signal) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      resolve(code ?? (signal ? 0 : 1));
    });
  });
}

if (!existsSync(sidecar)) {
  const sidecarBuild = spawnSync("pnpm", ["desktop:sidecar"], {
    cwd: root,
    stdio: "inherit",
  });
  if (sidecarBuild.status !== 0) {
    process.exit(sidecarBuild.status ?? 1);
  }
}

await freeLeakedDesktopVite(devPort);
process.exit(await runTauriDev(process.argv.slice(2)));
