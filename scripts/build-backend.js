// 用 PyInstaller 打包 Python 后端为 onedir 模式（backend.exe 启动器 + _internal/ 依赖），
// 然后拷贝到 Tauri sidecar 目录 + 资源目录。onedir 相比 onefile 冷启动快 10x（无需自解压）。
// 正式发布固定为 Windows GNU，与本机及 CI 的 Rust target 保持一致。

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
const RELEASE_TARGET = "x86_64-pc-windows-gnu";

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  execSync(cmd, {
    stdio: "inherit",
    cwd: ROOT,
    // 发布构建只允许使用当前虚拟环境，避免用户级 site-packages 污染或权限阻断。
    env: {
      ...process.env,
      PYTHONNOUSERSITE: "1",
      PYTHONUSERBASE: resolve(ROOT, "build/python-userbase"),
    },
    ...opts,
  });
}

function getTargetTriple() {
  // 从 rustc 解析 host triple，不写死
  const out = execSync("rustc -vV", { cwd: ROOT, encoding: "utf-8" });
  const m = out.match(/host:\s*(\S+)/);
  if (!m) throw new Error("无法从 rustc -vV 解析 host triple");
  return m[1];
}

console.log("=== 1. PyInstaller 打包后端（onedir）===");
const hostTriple = getTargetTriple();
if (hostTriple !== RELEASE_TARGET) {
  throw new Error(
    `发布构建要求 Rust host 为 ${RELEASE_TARGET}，当前为 ${hostTriple}。请切换 GNU 工具链后重试。`
  );
}
rmSync(DIST, { recursive: true, force: true });
rmSync(resolve(ROOT, "build/backend-tmp"), { recursive: true, force: true });
run(
  `python -m PyInstaller "${SPEC}" --distpath "${DIST}" --workpath "${resolve(
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
// Tauri bundler 按 target triple 查找 sidecar；只生成 GNU 名称，避免
// 通过复制同一 exe 伪装成 MSVC/GNU 双工具链而掩盖发布环境漂移。
const sidecarDst = resolve(BINARIES_DIR, `backend-${RELEASE_TARGET}.exe`);
copyFileSync(builtExe, sidecarDst);
console.log(`✓ sidecar: ${sidecarDst}`);

console.log("\n=== 3. 复制 _internal/ 到资源目录 ===");
// 通过 tauri.conf.json 的 resources map ({ "_internal": "_internal" }) 打包时
// 会被复制到安装目录下与 backend.exe 同级，backend.exe 启动时能找到依赖。
rmSync(INTERNAL_DST, { recursive: true, force: true });
cpSync(builtInternal, INTERNAL_DST, { recursive: true });
console.log(`✓ resources: ${INTERNAL_DST}`);

console.log("\n=== 完成 ===");
console.log("现在可运行: npm run tauri:build");
