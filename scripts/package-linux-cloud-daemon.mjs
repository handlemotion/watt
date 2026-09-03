#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(
  readFileSync(path.join(root, "packages/cloud-daemon/package.json"), "utf8"),
).version;
const deployDir = path.join(root, ".artifacts/watt-cloud-daemon");
const tarball = `Watt-cloud-daemon-v${version}-linux-x64.tar.gz`;
const outputDir = path.join(root, ".artifacts");

rmSync(deployDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

execSync("pnpm --filter @watt/cloud-daemon... build", {
  cwd: root,
  stdio: "inherit",
});
execSync(`pnpm deploy --filter @watt/cloud-daemon --prod --legacy ${deployDir}`, {
  cwd: root,
  stdio: "inherit",
});

mkdirSync(path.join(deployDir, "scripts"), { recursive: true });
cpSync(
  path.join(root, "packages/cloud-daemon/scripts/bootstrap.sh"),
  path.join(deployDir, "scripts/bootstrap.sh"),
);

const tarballPath = path.join(outputDir, tarball);
execSync(`tar -czf ${tarballPath} -C ${deployDir} .`, {
  cwd: root,
  stdio: "inherit",
});
const digest = createHash("sha256").update(readFileSync(tarballPath)).digest("hex");
writeFileSync(`${tarballPath}.sha256`, `${digest}  ${tarball}\n`);
process.stdout.write(`${JSON.stringify({ tarball: tarballPath, sha256: digest })}\n`);
