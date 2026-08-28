import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
);
const cargo = readFileSync(
  path.join(root, "apps", "desktop", "src-tauri", "Cargo.toml"),
  "utf8",
);
const cargoVersion = /^version = "([^"]+)"$/m.exec(cargo)?.[1];
const tag =
  process.argv[2] ?? process.env.GITHUB_REF_NAME ?? `v${manifest.version}`;

if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)) {
  throw new Error(
    `release tag must be stable SemVer vMAJOR.MINOR.PATCH: ${tag}`,
  );
}
if (tag !== `v${manifest.version}`) {
  throw new Error(
    `tag ${tag} does not match package version ${manifest.version}`,
  );
}
if (cargoVersion !== manifest.version) {
  throw new Error(
    `Cargo version ${cargoVersion ?? "missing"} does not match package version ${manifest.version}`,
  );
}

console.log(`Release version ${manifest.version} is consistent.`);
