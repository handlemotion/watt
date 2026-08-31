import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCT_PACKAGE = path.join("packages", "cli", "package.json");

export function readProductVersion(repoRoot = root) {
  const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, PRODUCT_PACKAGE), "utf8"),
  );
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error(`missing version in ${PRODUCT_PACKAGE}`);
  }
  return manifest.version;
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function replaceNamedVersion(source, name, version) {
  const pattern = new RegExp(`(name = "${name}"\\nversion = ")[^"]+(")`);
  const next = source.replace(pattern, `$1${version}$2`);
  if (next === source) {
    throw new Error(`could not update ${name} version to ${version}`);
  }
  return next;
}

export function syncReleaseVersion(
  repoRoot = root,
  version = readProductVersion(repoRoot),
) {
  const rootManifestPath = path.join(repoRoot, "package.json");
  const cargoTomlPath = path.join(
    repoRoot,
    "apps",
    "desktop",
    "src-tauri",
    "Cargo.toml",
  );
  const cargoLockPath = path.join(
    repoRoot,
    "apps",
    "desktop",
    "src-tauri",
    "Cargo.lock",
  );
  const desktopManifestPath = path.join(
    repoRoot,
    "apps",
    "desktop",
    "package.json",
  );

  const rootManifest = JSON.parse(readFileSync(rootManifestPath, "utf8"));
  rootManifest.version = version;
  writeJson(rootManifestPath, rootManifest);

  const desktopManifest = JSON.parse(readFileSync(desktopManifestPath, "utf8"));
  desktopManifest.version = version;
  writeJson(desktopManifestPath, desktopManifest);

  const cargoToml = readFileSync(cargoTomlPath, "utf8");
  writeFileSync(
    cargoTomlPath,
    replaceNamedVersion(cargoToml, "watt-desktop", version),
  );

  const cargoLock = readFileSync(cargoLockPath, "utf8");
  writeFileSync(
    cargoLockPath,
    replaceNamedVersion(cargoLock, "watt-desktop", version),
  );

  return version;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const version = syncReleaseVersion();
  console.log(`Synced release version ${version}.`);
}
