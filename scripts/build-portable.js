// Build the no-install Windows browser edition:
//   backend.exe + PyInstaller _internal/ + Vite web/ + launch/stop helpers.
// The final ZIP includes an exact source snapshot for the bundled AGPL software.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const RELEASE = resolve(ROOT, "release");
const PACKAGE = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const VERSION = PACKAGE.version;
const FOLDER_NAME = `PDF-Reader-Translate-Portable-${VERSION}-Windows-x64`;
const OUTPUT = resolve(RELEASE, FOLDER_NAME);
const ZIP_PATH = resolve(RELEASE, `${FOLDER_NAME}.zip`);
const HASH_PATH = `${ZIP_PATH}.sha256`;
const BACKEND_BUILD = resolve(ROOT, "build/backend/backend");
const WEB_BUILD = resolve(ROOT, "dist");

function run(program, args, options = {}) {
  console.log(`$ ${program} ${args.join(" ")}`);
  execFileSync(program, args, {
    cwd: ROOT,
    stdio: "inherit",
    ...options,
  });
}

function runNpm(script) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) {
    throw new Error("未找到 npm_execpath，请通过 npm run portable:build 启动");
  }
  run(process.execPath, [npmCli, "run", script]);
}

function copySourceSnapshot(target) {
  const snapshotParent = resolve(ROOT, "build/portable-source");
  const snapshotName = `pdf-reader-translate-source-${VERSION}`;
  const snapshotRoot = resolve(snapshotParent, snapshotName);
  rmSync(snapshotParent, { recursive: true, force: true });
  mkdirSync(snapshotRoot, { recursive: true });

  const listed = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: ROOT },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);

  for (const relative of listed) {
    const source = resolve(ROOT, relative);
    if (!existsSync(source) || !statSync(source).isFile()) continue;
    const destination = resolve(snapshotRoot, relative);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }

  mkdirSync(target, { recursive: true });
  const archive = resolve(target, `${snapshotName}.zip`);
  run("tar.exe", ["-a", "-c", "-f", archive, snapshotName], {
    cwd: snapshotParent,
  });
  rmSync(snapshotParent, { recursive: true, force: true });
}

console.log("=== 1. 构建前端与冻结后端 ===");
runNpm("build");
runNpm("build:backend");

if (!existsSync(resolve(BACKEND_BUILD, "backend.exe"))) {
  throw new Error(`后端构建产物不存在: ${BACKEND_BUILD}`);
}
if (!existsSync(resolve(WEB_BUILD, "index.html"))) {
  throw new Error(`前端构建产物不存在: ${WEB_BUILD}`);
}

console.log("\n=== 2. 组装免安装便携目录 ===");
mkdirSync(RELEASE, { recursive: true });
rmSync(OUTPUT, { recursive: true, force: true });
rmSync(ZIP_PATH, { force: true });
rmSync(HASH_PATH, { force: true });
cpSync(BACKEND_BUILD, OUTPUT, { recursive: true });
cpSync(WEB_BUILD, resolve(OUTPUT, "web"), { recursive: true });
copyFileSync(resolve(ROOT, "LICENSE"), resolve(OUTPUT, "LICENSE-MIT.txt"));

const pdf2zhLicense = execFileSync(
  "python",
  [
    "-c",
    "import importlib.metadata as m; d=m.distribution('pdf2zh'); print(d.locate_file('pdf2zh-1.9.11.dist-info/licenses/LICENSE'))",
  ],
  { cwd: ROOT, encoding: "utf8" },
).trim();
if (existsSync(pdf2zhLicense)) {
  copyFileSync(pdf2zhLicense, resolve(OUTPUT, "LICENSE-pdf2zh-AGPL-3.0.txt"));
}

writeFileSync(
  resolve(OUTPUT, "启动 PDF 阅读翻译.cmd"),
  '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\nstart "" "%~dp0backend.exe"\r\n',
  "utf8",
);
writeFileSync(
  resolve(OUTPUT, "停止 PDF 阅读翻译.cmd"),
  '@echo off\r\nsetlocal\r\nset "PDF_READER_BACKEND=%~dp0backend.exe"\r\npowershell.exe -NoProfile -Command "$target=[IO.Path]::GetFullPath($env:PDF_READER_BACKEND); Get-Process -Name backend -ErrorAction SilentlyContinue | Where-Object { try { [IO.Path]::GetFullPath($_.Path) -eq $target } catch { $false } } | Stop-Process -Force"\r\n',
  "utf8",
);
writeFileSync(
  resolve(OUTPUT, "便携版使用说明.txt"),
  `PDF 阅读翻译 ${VERSION} Windows x64 免安装便携版\r\n\r\n` +
    `1. 请先完整解压 ZIP，不要直接在压缩软件里运行。\r\n` +
    `2. 双击“启动 PDF 阅读翻译.cmd”，程序会启动本地后端并打开默认浏览器。\r\n` +
    `3. 页面地址是 http://127.0.0.1:8765/，数据只在本机浏览器与本地后端之间传输。\r\n` +
    `4. 使用结束后双击“停止 PDF 阅读翻译.cmd”关闭后台服务。\r\n\r\n` +
    `无需安装 Python、Node.js、Rust 或 WebView2；需要 Windows 10/11 x64 和现代浏览器。\r\n` +
    `API Key 保存在当前浏览器的本地存储中，不会写入本压缩包。\r\n` +
    `若 8765 端口被其他程序占用，请先关闭旧版 PDF 阅读翻译或其他占用该端口的程序。\r\n\r\n` +
    `源代码：https://github.com/klu6163-droid/pdf-reader-translate\r\n` +
    `本包的完整对应源码快照位于 SOURCE 目录。\r\n`,
  "utf8",
);

console.log("\n=== 3. 附加对应源码快照 ===");
copySourceSnapshot(resolve(OUTPUT, "SOURCE"));

console.log("\n=== 4. 创建标准 ZIP 与 SHA-256 ===");
run("tar.exe", ["-a", "-c", "-f", ZIP_PATH, FOLDER_NAME], { cwd: RELEASE });
const hash = createHash("sha256").update(readFileSync(ZIP_PATH)).digest("hex").toUpperCase();
writeFileSync(HASH_PATH, `${hash}  ${FOLDER_NAME}.zip\r\n`, "utf8");

console.log("\n=== 完成 ===");
console.log(`目录: ${OUTPUT}`);
console.log(`压缩包: ${ZIP_PATH}`);
console.log(`SHA-256: ${hash}`);
