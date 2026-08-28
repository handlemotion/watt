import type { GitWorktree } from "./types.js";

export function parseWorktreePorcelain(stdout: string): GitWorktree[] {
  const blocks = stdout.split("\n\n").map((block) => block.trim()).filter(Boolean);
  const worktrees: GitWorktree[] = [];
  for (const block of blocks) {
    let pathValue: string | undefined;
    let head = "";
    let branch: string | null = null;
    let bare = false;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) {
        pathValue = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length);
        branch = ref.replace(/^refs\/heads\//, "");
      } else if (line === "bare") {
        bare = true;
      } else if (line === "detached") {
        branch = null;
      }
    }
    if (pathValue !== undefined) {
      worktrees.push({ path: pathValue, head, branch, bare });
    }
  }
  return worktrees;
}
