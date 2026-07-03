// 用 PyInstaller 打包 Python 后端为单一 exe，复制到 Tauri sidecar 目录。
// sidecar 文件名需带 target triple 后缀（如 -x86_64-pc-windows-gnu）。

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SPEC = resolve(ROOT, "backend/backend.spec");
const DIST = resolve(ROOT, "build/backend");
const BINARIES_DIR = resolve(ROOT, "src-tauri/binaries");

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts });
}

function getTargetTriple() {
  // 从 rustc 解析 host triple，不写死
  const out = execSync("rustc -vV", { cwd: ROOT, encoding: "utf-8" });
  const m = out.match(/host:\s*(\S+)/);
  if (!m) throw new Error("无法从 rustc -vV 解析 host triple");
  return m[1];
}

console.log("=== 1. PyInstaller 打包后端 ===");
rmSync(DIST, { recursive: true, force: true });
rmSync(resolve(ROOT, "build/backend-tmp"), { recursive: true, force: true });
run(`pyinstaller "${SPEC}" --distpath "${DIST}" --workpath "${resolve(ROOT, "build/backend-tmp")}" --noconfirm`);

const builtExe = resolve(DIST, "backend.exe");
if (!existsSync(builtExe)) {
  console.error(`!! 未找到产物: ${builtExe}`);
  process.exit(1);
}

console.log("\n=== 2. 复制到 Tauri sidecar 目录（带 target triple 后缀）===");
mkdirSync(BINARIES_DIR, { recursive: true });

// Tauri bundler（tauri-cli）与 app 运行时可能用不同 triple 查找 sidecar：
// - bundler 用 tauri-cli 编译时的 triple（常为 msvc）
// - 运行时 app 找的是不带 triple 的 backend.exe（bundler 打包时去 triple 重命名）
// 为兼容，同时放 gnu 和 msvc 两个命名副本，bundler 找到任一即可。
const hostTriple = getTargetTriple();
const triples = new Set([hostTriple, "x86_64-pc-windows-msvc", "x86_64-pc-windows-gnu"]);
for (const tr of triples) {
  const dst = resolve(BINARIES_DIR, `backend-${tr}.exe`);
  copyFileSync(builtExe, dst);
  console.log(`✓ sidecar: ${dst}`);
}

console.log("\n=== 完成 ===");
console.log("现在可运行: npm run tauri:build");
