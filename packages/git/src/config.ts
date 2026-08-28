import { readFile } from "node:fs/promises";
import path from "node:path";

import { GitError } from "./errors.js";
import type { WattJson } from "./types.js";

export type SetupSpec = {
  copy: string[];
  commands: string[];
};

function asCommandList(value: unknown): string[] {
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  }
  return [];
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (cause) {
    if (isEnoent(cause)) {
      return null;
    }
    throw new GitError(`failed to read ${filePath}`, "config_invalid", { cause });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new GitError(`invalid JSON: ${filePath}`, "config_invalid", { cause });
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  throw new GitError(`invalid JSON object: ${filePath}`, "config_invalid");
}

function isEnoent(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";
}

export async function loadWorktreeConfig(
  repoRoot: string,
  extraCopyGlobs: string[] | undefined,
): Promise<SetupSpec> {
  const extra = extraCopyGlobs ?? [];
  const watt = await readJsonObject(path.join(repoRoot, "watt.json"));
  if (watt !== null) {
    const copyFromFile = Array.isArray(watt.copy)
      ? watt.copy.filter((item): item is string => typeof item === "string")
      : [];
    return {
      copy: [...copyFromFile, ...extra],
      commands: asCommandList(watt.setup),
    };
  }

  const cursorFile = path.join(repoRoot, ".cursor", "worktrees.json");
  const cursor = await readJsonObject(cursorFile);
  const copy = extra;
  if (cursor === null) {
    return { copy, commands: [] };
  }
  const unix = cursor["setup-worktree-unix"];
  const fallback = cursor["setup-worktree"];
  const spec = unix ?? fallback;
  if (typeof spec === "string") {
    const scriptPath = path.isAbsolute(spec) ? spec : path.join(repoRoot, ".cursor", spec);
    return { copy, commands: [scriptPath] };
  }
  return { copy, commands: asCommandList(spec) };
}

export type { WattJson };
