import { homedir } from "node:os";
import path from "node:path";

import { createHost, type Host, type Project } from "@watt/host";
import { Command } from "commander";

type GlobalOpts = {
  repo?: string;
  stateDir: string;
  worktreeRoot?: string;
};

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseModelParams(
  values: string[],
): Array<{ id: string; value: string }> {
  const seen = new Set<string>();
  return values.map((entry) => {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new Error(`invalid --model-param: ${entry}; expected id=value`);
    }
    const id = entry.slice(0, separator);
    if (seen.has(id)) throw new Error(`duplicate --model-param: ${id}`);
    seen.add(id);
    return { id, value: entry.slice(separator + 1) };
  });
}

function parseMode(value: string | undefined): "agent" | "plan" {
  if (value === undefined || value === "agent") return "agent";
  if (value === "plan") return "plan";
  throw new Error(`invalid --mode: ${value}; expected agent or plan`);
}

function parseRuntime(
  value: string | undefined,
): "cursor-local" | "codex-local" {
  if (value === undefined || value === "cursor") return "cursor-local";
  if (value === "chatgpt") return "codex-local";
  throw new Error(`invalid --runtime: ${value}; expected cursor or chatgpt`);
}

function parseSequence(value: string): number {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new Error(
      `invalid sequence: ${value}; expected a non-negative integer`,
    );
  }
  return sequence;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function waitForDispatch(host: Host, runId: string) {
  for (;;) {
    const run = host.runs.get(runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    if (run.status !== "queued") {
      if (run.status === "error") {
        const result = await host.runs.wait({ runId });
        throw new Error(
          `run failed before detach: ${result.error?.message ?? "unknown error"}`,
        );
      }
      return run;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
}

function assertDetachSupported(
  runtime: ReturnType<typeof parseRuntime> | undefined,
): void {
  if (runtime === "codex-local") {
    throw new Error(
      "Codex sessions do not support --detach because in-flight runs cannot be recovered after CLI exit",
    );
  }
}

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
    await host.suspend();
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
        writeJson(workspace);
      });
    });

  worktree.command("ls").action(async () => {
    const opts = program.opts<GlobalOpts>();
    await withHost(opts, true, true, async (host, project) => {
      if (!project) throw new Error("--repo is required");
      const rows = host.workspaces.list({ projectId: project.id });
      writeJson(rows);
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
          writeJson(workspace);
        },
      );
    });

  program.command("capabilities").action(async () => {
    const opts = program.opts<GlobalOpts>();
    await withHost(opts, false, false, async (host) => {
      writeJson(await host.capabilities());
    });
  });

  const project = program.command("project");
  project.command("ls").action(async () => {
    const opts = program.opts<GlobalOpts>();
    await withHost(opts, false, false, async (host) => {
      writeJson(host.projects.list());
    });
  });
  project
    .command("reconcile")
    .requiredOption("--project <id>", "project id")
    .action(async (flags: { project: string }) => {
      const opts = program.opts<GlobalOpts>();
      await withHost(opts, false, false, async (host) => {
        writeJson(await host.projects.reconcile({ projectId: flags.project }));
      });
    });

  const operation = program.command("operation");
  operation
    .command("get")
    .requiredOption("--operation <id>", "operation id")
    .action(async (flags: { operation: string }) => {
      const opts = program.opts<GlobalOpts>();
      await withHost(opts, false, false, async (host) => {
        writeJson(
          host.diagnostics.operations.get({ operationId: flags.operation }) ??
            null,
        );
      });
    });
  operation
    .command("ls")
    .option("--project <id>", "project id")
    .option("--workspace <id>", "workspace id")
    .option("--include-completed", "include completed operations")
    .action(
      async (flags: {
        project?: string;
        workspace?: string;
        includeCompleted?: boolean;
      }) => {
        const opts = program.opts<GlobalOpts>();
        await withHost(opts, false, false, async (host) => {
          writeJson(
            host.diagnostics.operations.list({
              ...(flags.project === undefined
                ? {}
                : { projectId: flags.project }),
              ...(flags.workspace === undefined
                ? {}
                : { workspaceId: flags.workspace }),
              ...(flags.includeCompleted === undefined
                ? {}
                : { includeCompleted: flags.includeCompleted }),
            }),
          );
        });
      },
    );

  const agent = program.command("agent");
  agent
    .command("ls")
    .requiredOption("--workspace <id>", "workspace id")
    .action(async (flags: { workspace: string }) => {
      const opts = program.opts<GlobalOpts>();
      await withHost(opts, false, false, async (host) => {
        writeJson(host.sessions.list({ workspaceId: flags.workspace }));
      });
    });

  agent
    .command("send")
    .option("--workspace <id>", "workspace id for a new session")
    .option("--session <id>", "existing session id for a follow-up")
    .requiredOption("-p, --prompt <text>", "prompt")
    .option("--model <id>", "model id")
    .option(
      "--model-param <id=value>",
      "selected model parameter (repeatable)",
      collect,
      [],
    )
    .option("--mode <agent|plan>", "conversation mode")
    .option("--runtime <cursor|chatgpt>", "agent runtime")
    .option("--detach", "return after durable Cursor provider dispatch")
    .action(
      async (flags: {
        workspace?: string;
        session?: string;
        prompt: string;
        model?: string;
        modelParam: string[];
        mode?: string;
        runtime?: string;
        detach?: boolean;
      }) => {
        const opts = program.opts<GlobalOpts>();
        if (Boolean(flags.workspace) === Boolean(flags.session)) {
          throw new Error(
            "exactly one of --workspace or --session is required",
          );
        }
        const params = parseModelParams(flags.modelParam);
        if (!flags.model && params.length > 0) {
          throw new Error("--model is required when using --model-param");
        }
        if (
          flags.session &&
          (flags.model !== undefined ||
            flags.modelParam.length > 0 ||
            flags.mode !== undefined ||
            flags.runtime !== undefined)
        ) {
          throw new Error(
            "--model, --model-param, --mode, and --runtime are only valid with --workspace",
          );
        }
        const mode = flags.workspace ? parseMode(flags.mode) : undefined;
        const runtime = flags.workspace
          ? parseRuntime(flags.runtime)
          : undefined;
        if (flags.detach) assertDetachSupported(runtime);
        await withHost(opts, false, false, async (host) => {
          if (flags.detach && flags.session) {
            assertDetachSupported(host.sessions.get(flags.session)?.runtime);
          }
          const created = flags.workspace
            ? await host.sessions.create({
                workspaceId: flags.workspace,
                prompt: flags.prompt,
                runtime,
                model:
                  flags.model === undefined
                    ? undefined
                    : { id: flags.model, params },
                mode,
              })
            : await host.sessions.send({
                sessionId: flags.session as string,
                prompt: flags.prompt,
              });
          const { session, run } = created;
          if (flags.detach) {
            const dispatched = await waitForDispatch(host, run.id);
            writeJson({ sessionId: session.id, runId: dispatched.id });
            return;
          }
          for await (const event of host.runs.attach({ runId: run.id })) {
            writeJson(event);
          }
          const result = await host.runs.wait({ runId: run.id });
          writeJson(result);
          if (result.status !== "finished") process.exitCode = 1;
        });
      },
    );

  const run = program.command("run");
  run
    .command("get")
    .requiredOption("--run <id>", "run id")
    .action(async (flags: { run: string }) => {
      const opts = program.opts<GlobalOpts>();
      await withHost(opts, false, false, async (host) => {
        writeJson(host.runs.get(flags.run) ?? null);
      });
    });
  run
    .command("ls")
    .requiredOption("--session <id>", "session id")
    .action(async (flags: { session: string }) => {
      const opts = program.opts<GlobalOpts>();
      await withHost(opts, false, false, async (host) => {
        writeJson(host.runs.list({ sessionId: flags.session }));
      });
    });
  for (const commandName of ["wait", "cancel"] as const) {
    run
      .command(commandName)
      .requiredOption("--run <id>", "run id")
      .action(async (flags: { run: string }) => {
        const opts = program.opts<GlobalOpts>();
        await withHost(opts, false, false, async (host) => {
          writeJson(await host.runs[commandName]({ runId: flags.run }));
        });
      });
  }
  run
    .command("attach")
    .requiredOption("--run <id>", "run id")
    .option(
      "--after-sequence <number>",
      "exclusive event sequence cursor",
      parseSequence,
    )
    .action(async (flags: { run: string; afterSequence?: number }) => {
      const opts = program.opts<GlobalOpts>();
      await withHost(opts, false, false, async (host) => {
        for await (const event of host.runs.attach({
          runId: flags.run,
          ...(flags.afterSequence === undefined
            ? {}
            : { afterSequence: flags.afterSequence }),
        })) {
          writeJson(event);
        }
        const result = await host.runs.wait({ runId: flags.run });
        writeJson(result);
        if (result.status !== "finished") process.exitCode = 1;
      });
    });

  return program;
}

export async function runCli(argv: string[]): Promise<void> {
  await createProgram().parseAsync(argv);
}
