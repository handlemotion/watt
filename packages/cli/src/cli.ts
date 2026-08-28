#!/usr/bin/env node
import { runCli } from "./program.js";

try {
  await runCli(process.argv);
} catch (error) {
  const message = error instanceof Error ? error.message : "watt failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
