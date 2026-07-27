// 用 PyInstaller 打包 Python 后端为 onedir 模式（backend.exe 启动器 + _internal/ 依赖），
// 然后拷贝到 Tauri sidecar 目录 + 资源目录。onedir 相比 onefile 冷启动快 10x（无需自解压）。
// sidecar 文件名需带 target triple 后缀（如 -x86_64-pc-windows-msvc）。

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, cpSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SPEC = resolve(ROOT, "backend/backend.spec");
const DIST = resolve(ROOT, "build/backend");
const BINARIES_DIR = resolve(ROOT, "src-tauri/binaries");
const INTERNAL_DST = resolve(ROOT, "src-tauri/_internal");

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

console.log("=== 1. PyInstaller 打包后端（onedir）===");
rmSync(DIST, { recursive: true, force: true });
rmSync(resolve(ROOT, "build/backend-tmp"), { recursive: true, force: true });
run(
  `pyinstaller "${SPEC}" --distpath "${DIST}" --workpath "${resolve(
    ROOT,
    "build/backend-tmp"
  )}" --noconfirm`
);

// onedir 产物结构：build/backend/backend/{backend.exe, _internal/}
const oneDirRoot = resolve(DIST, "backend");
const builtExe = resolve(oneDirRoot, "backend.exe");
const builtInternal = resolve(oneDirRoot, "_internal");
if (!existsSync(builtExe) || !existsSync(builtInternal)) {
  console.error(`!! onedir 产物缺失: ${builtExe} 或 ${builtInternal}`);
  process.exit(1);
}

console.log("\n=== 2. 复制 backend.exe 到 sidecar 目录（带 target triple 后缀）===");
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

console.log("\n=== 3. 复制 _internal/ 到资源目录 ===");
// 通过 tauri.conf.json 的 resources map ({ "_internal": "_internal" }) 打包时
// 会被复制到安装目录下与 backend.exe 同级，backend.exe 启动时能找到依赖。
rmSync(INTERNAL_DST, { recursive: true, force: true });
cpSync(builtInternal, INTERNAL_DST, { recursive: true });
console.log(`✓ resources: ${INTERNAL_DST}`);

console.log("\n=== 完成 ===");
console.log("现在可运行: npm run tauri:build");
