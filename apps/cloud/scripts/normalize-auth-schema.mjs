import { readFile, writeFile } from "node:fs/promises";

const target = new URL("../src/db/auth-schema.ts", import.meta.url);
const source = await readFile(target, "utf8");
const generated =
  'clientCredentialsScopes: text("client_credentials_scopes")\n      .array()\n      .default(),';
const normalized =
  'clientCredentialsScopes: text("client_credentials_scopes")\n      .array()\n      .default([]),';

if (source.includes(generated)) {
  await writeFile(target, source.replace(generated, normalized));
} else if (!source.includes(normalized)) {
  throw new Error("Better Auth schema shape changed; review the generated default");
}
