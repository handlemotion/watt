import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets = ["cli", "host"];
const buildPackages = ["agent", "git", "host", "cli"];
const samples = 15;
const tsc = path.join(root, "node_modules", "typescript", "bin", "tsc");

for (const packageName of buildPackages) {
  const built = spawnSync(
    process.execPath,
    [tsc, "-p", path.join(root, "packages", packageName, "tsconfig.json")],
    {
      cwd: root,
      stdio: "inherit",
    },
  );
  if (built.status !== 0) process.exit(built.status ?? 1);
}

function percentile(values, fraction) {
  const index = Math.min(
    values.length - 1,
    Math.ceil(values.length * fraction) - 1,
  );
  return [...values].sort((a, b) => a - b)[index];
}

function sample(target) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(
      process.execPath,
      ["scripts/startup-sample.mjs", target],
      { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0)
        return reject(new Error(`startup sample failed (${code}): ${stderr}`));
      try {
        const inner = JSON.parse(stdout);
        resolve({
          elapsedMs: performance.now() - started,
          rssBytes: inner.rssBytes,
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}

for (const target of targets) {
  const results = [];
  for (let index = 0; index < samples; index += 1)
    results.push(await sample(target));
  const elapsed = results.map((result) => result.elapsedMs);
  const rss = results.map((result) => result.rssBytes / (1024 * 1024));
  process.stdout.write(
    `${target}: median ${percentile(elapsed, 0.5).toFixed(1)} ms, p95 ${percentile(elapsed, 0.95).toFixed(1)} ms, median RSS ${percentile(rss, 0.5).toFixed(1)} MB, p95 RSS ${percentile(rss, 0.95).toFixed(1)} MB\n`,
  );
}
