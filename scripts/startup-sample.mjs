import { pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const target = process.argv[2];
const started = performance.now();

if (target === "cli") {
  const { createProgram } = await import(
    pathToFileURL(path.join(root, "packages/cli/dist/program.js")).href
  );
  createProgram().helpInformation();
} else if (target === "host") {
  await import(pathToFileURL(path.join(root, "packages/host/dist/index.js")).href);
} else {
  throw new Error(`unknown startup target: ${String(target)}`);
}

process.stdout.write(
  `${JSON.stringify({ elapsedMs: performance.now() - started, rssBytes: process.memoryUsage().rss })}\n`,
);
