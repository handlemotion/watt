import { homedir } from "node:os";
import path from "node:path";

import { createHost, type Host, type Project } from "@watt/host";
import { Command } from "commander";

type GlobalOpts = {
  repo?: string;
  stateDir: string;
  worktreeRoot?: string;
};

async function withHost<T>(
  opts: GlobalOpts,
  requireRepo: boolean,
  registerRepo: boolean,
  run: (host: Host, project?: Project) => Promise<T>,
): Promise<T> {
  if (requireRepo && !opts.repo) {
    throw new Error("--repo is required");
  }
  const worktreeRoot = path.resolve(
    opts.worktreeRoot ??
      (opts.repo
        ? path.dirname(path.resolve(opts.repo))
        : path.join(path.resolve(opts.stateDir), "worktrees")),
  );
  const host = await createHost({
    stateDir: path.resolve(opts.stateDir),
    worktreeRoot,
    apiKey: process.env.CURSOR_API_KEY,
  });
  try {
    const project =
      registerRepo && opts.repo
        ? await host.projects.register(path.resolve(opts.repo))
        : undefined;
    return await run(host, project);
  } finally {
    await host.close();
  }
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name("watt")
    .description("Cursor-native worktree host")
    .option("--repo <path>", "git checkout to register")
    .option(
      "--state-dir <dir>",
      "sqlite state directory",
      path.join(homedir(), ".watt"),
    )
    .option("--worktree-root <dir>", "directory for sibling worktrees");

  const worktree = program.command("worktree");

  worktree
    .command("create")
    .requiredOption("--slug <slug>", "workspace slug")
    .option("--branch <branch>", "new branch name")
    .option("--base <ref>", "base ref")
    .action(async (flags: { slug: string; branch?: string; base?: string }) => {
      const opts = program.opts<GlobalOpts>();
      await withHost(opts, true, true, async (host, project) => {
        if (!project) throw new Error("--repo is required");
        const workspace = await host.workspaces.create({
          projectId: project.id,
          slug: flags.slug,
          branch: flags.branch,
          baseRef: flags.base,
        });
        process.stdout.write(`${JSON.stringify(workspace)}\n`);
      });
    });

  worktree.command("ls").action(async () => {
    const opts = program.opts<GlobalOpts>();
    await withHost(opts, true, true, async (host, project) => {
      if (!project) throw new Error("--repo is required");
      const rows = host.workspaces.list({ projectId: project.id });
      process.stdout.write(`${JSON.stringify(rows)}\n`);
    });
  });

  worktree
    .command("archive")
    .requiredOption("--workspace <id>", "workspace id")
    .action(async (flags: { workspace: string }) => {
      const opts = program.opts<GlobalOpts>();
      await withHost(
        opts,
        Boolean(opts.repo),
        Boolean(opts.repo),
        async (host) => {
          const workspace = await host.workspaces.archive({
            workspaceId: flags.workspace,
          });
          process.stdout.write(`${JSON.stringify(workspace)}\n`);
        },
      );
    });

  program
    .command("agent")
    .command("send")
    .requiredOption("--workspace <id>", "workspace id")
    .requiredOption("-p, --prompt <text>", "prompt")
    .option("--model <id>", "model id")
    .action(
      async (flags: { workspace: string; prompt: string; model?: string }) => {
        const opts = program.opts<GlobalOpts>();
        await withHost(opts, false, false, async (host) => {
          const { run } = await host.sessions.create({
            workspaceId: flags.workspace,
            prompt: flags.prompt,
            model: flags.model,
          });
          for await (const event of host.runs.attach({ runId: run.id })) {
            process.stdout.write(`${JSON.stringify(event)}\n`);
          }
        });
      },
    );

  return program;
}

export async function runCli(argv: string[]): Promise<void> {
  await createProgram().parseAsync(argv);
}
