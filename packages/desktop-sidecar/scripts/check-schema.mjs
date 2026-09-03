import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const packageRoot = new URL("../", import.meta.url);
const schemaBytes = await readFile(new URL("protocol.schema.json", packageRoot));
const expected = (await readFile(new URL("protocol.schema.sha256", packageRoot), "utf8")).trim();
const actual = createHash("sha256").update(schemaBytes).digest("hex");

if (actual !== expected) {
  throw new Error(
    `protocol schema changed (${actual}); review both runtimes and update protocol.schema.sha256`,
  );
}

const schema = JSON.parse(schemaBytes.toString("utf8"));
if (schema.$id !== "https://watt.dev/schemas/desktop-sidecar-v1.json") {
  throw new Error("protocol schema $id changed unexpectedly");
}

const rustProtocol = await readFile(
  new URL("../../apps/desktop/src-tauri/src/protocol.rs", packageRoot),
  "utf8",
);
for (const marker of [
  "pub const PROTOCOL_VERSION: u32 = 1;",
  "pub const MAX_FRAME_BYTES: usize = 1024 * 1024;",
  'include_str!("../../../../packages/desktop-sidecar/protocol.schema.json")',
]) {
  if (!rustProtocol.includes(marker)) {
    throw new Error(`Rust protocol is missing schema marker: ${marker}`);
  }
}
