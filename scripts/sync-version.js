// Keep all derived application versions aligned with src-tauri/tauri.conf.json.
// Uses Node built-ins only; --check never writes, --write updates mismatches.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2];

if (mode !== "--check" && mode !== "--write") {
  console.error("Usage: node scripts/sync-version.js --check|--write");
  process.exit(2);
}

const read = (path) => readFileSync(resolve(ROOT, path), "utf8");
const write = (path, content) => writeFileSync(resolve(ROOT, path), content, "utf8");
const source = JSON.parse(read("src-tauri/tauri.conf.json"));
const version = source.version;

if (
  typeof version !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
) {
  throw new Error(`Invalid version in src-tauri/tauri.conf.json: ${String(version)}`);
}

function replaceRequired(content, pattern, replacement, path) {
  if (!pattern.test(content)) throw new Error(`Version field not found in ${path}`);
  return content.replace(pattern, replacement);
}

const targets = [
  {
    path: "package.json",
    readVersion: (content) => JSON.parse(content).version,
    update: (content) =>
      replaceRequired(content, /^(\s*"version"\s*:\s*")[^"]+("\s*,)/m, `$1${version}$2`, "package.json"),
  },
  {
    path: "package-lock.json",
    readVersion: (content) => {
      const lock = JSON.parse(content);
      const rootVersion = lock.packages?.[""]?.version;
      return lock.version === rootVersion ? lock.version : `${lock.version} / ${rootVersion}`;
    },
    update: (content) => {
      let next = replaceRequired(
        content,
        /^(\s*"version"\s*:\s*")[^"]+("\s*,)/m,
        `$1${version}$2`,
        "package-lock.json",
      );
      next = replaceRequired(
        next,
        /("packages"\s*:\s*\{\s*""\s*:\s*\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"version"\s*:\s*")[^"]+("\s*,)/,
        `$1${version}$2`,
        "package-lock.json packages root",
      );
      return next;
    },
  },
  {
    path: "src-tauri/Cargo.toml",
    readVersion: (content) => content.match(/^version\s*=\s*"([^"]+)"/m)?.[1],
    update: (content) =>
      replaceRequired(content, /^(version\s*=\s*")[^"]+("\s*)$/m, `$1${version}$2`, "src-tauri/Cargo.toml"),
  },
  {
    path: "src-tauri/Cargo.lock",
    readVersion: (content) =>
      content.match(/\[\[package\]\]\s*name\s*=\s*"pdf-reader-translate"\s*version\s*=\s*"([^"]+)"/)?.[1],
    update: (content) =>
      replaceRequired(
        content,
        /(\[\[package\]\]\s*name\s*=\s*"pdf-reader-translate"\s*version\s*=\s*")[^"]+(")/,
        `$1${version}$2`,
        "src-tauri/Cargo.lock",
      ),
  },
  {
    path: "backend/app/main.py",
    readVersion: (content) => content.match(/\bapp\s*=\s*FastAPI\([^\r\n]*\bversion\s*=\s*"([^"]+)"/)?.[1],
    update: (content) =>
      replaceRequired(
        content,
        /(\bapp\s*=\s*FastAPI\([^\r\n]*\bversion\s*=\s*")[^"]+(")/,
        `$1${version}$2`,
        "backend/app/main.py",
      ),
  },
];

const mismatches = [];
for (const target of targets) {
  const content = read(target.path);
  const current = target.readVersion(content);
  if (current === version) continue;
  mismatches.push(`${target.path}: ${String(current)} -> ${version}`);
  if (mode === "--write") write(target.path, target.update(content));
}

if (mismatches.length === 0) {
  console.log(`Version ${version}: all files are consistent`);
} else if (mode === "--write") {
  console.log(`Version ${version}: synchronized`);
  for (const item of mismatches) console.log(`- ${item}`);
} else {
  console.error(`Version ${version}: mismatch detected`);
  for (const item of mismatches) console.error(`- ${item}`);
  process.exit(1);
}
