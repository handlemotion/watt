import { execFileSync } from "node:child_process";
import { appendFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readProductVersion } from "./sync-release-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const VERSION_PATHS = new Set([
  "package.json",
  "apps/desktop/package.json",
  "apps/desktop/src-tauri/Cargo.lock",
  "apps/desktop/src-tauri/Cargo.toml",
  "packages/agent/package.json",
  "packages/cli/package.json",
  "packages/desktop-sidecar/package.json",
  "packages/git/package.json",
  "packages/host/package.json",
]);

export function pendingChangesetFiles(names) {
  return names.filter((name) => name.endsWith(".md") && name !== "README.md");
}

export function evaluateReleaseGate({
  hasChangesets,
  pendingChangesets,
  tagExists,
  changedFiles,
  version,
}) {
  const tag = `v${version}`;
  if (hasChangesets || pendingChangesets.length > 0 || tagExists) {
    return { shouldPackage: false, tag, version };
  }
  const bumped = changedFiles.some(
    (file) => VERSION_PATHS.has(file) || file.endsWith("CHANGELOG.md"),
  );
  return { shouldPackage: bumped, tag, version };
}

function git(args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function tagExists(tag) {
  try {
    git(["rev-parse", "-q", "--verify", `refs/tags/${tag}`]);
    return true;
  } catch {
    try {
      git(["ls-remote", "--exit-code", "origin", `refs/tags/${tag}`]);
      return true;
    } catch {
      return false;
    }
  }
}

function changedFilesInHead() {
  try {
    return git(["diff", "--name-only", "-M", "HEAD^", "HEAD"]).split("\n").filter(Boolean);
  } catch {
    return git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])
      .split("\n")
      .filter(Boolean);
  }
}

function writeOutput(key, value) {
  const githubOutput = process.env.GITHUB_OUTPUT;
  const line = `${key}=${value}`;
  if (githubOutput) appendFileSync(githubOutput, `${line}\n`);
  console.log(line);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const version = readProductVersion();
  const decision = evaluateReleaseGate({
    hasChangesets: process.env.HAS_CHANGESETS === "true",
    pendingChangesets: pendingChangesetFiles(readdirSync(path.join(root, ".changeset"))),
    tagExists: tagExists(`v${version}`),
    changedFiles: changedFilesInHead(),
    version,
  });
  writeOutput("should-package", decision.shouldPackage ? "true" : "false");
  writeOutput("version", decision.version);
  writeOutput("tag", decision.tag);
}
