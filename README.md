# PDF 阅读翻译（MVP）

左右分栏的文献 PDF 阅读 + 翻译工具。左侧原始 PDF，右侧三大功能：**划词翻译 / 全文翻译 / 文献总结**。

- 前端：React + TypeScript + Vite + Tailwind
- 桌面端：Tauri v2
- PDF 渲染：PDF.js（pdfjs-dist）
- 后端：Python FastAPI（作为 sidecar 由 Tauri 拉起）
- 全文翻译：封装 pdf2zh / PDFMathTranslate（未安装时自动降级为纯文本翻译）
- AI 调用：统一的 OpenAI-compatible LLM 层

> **重要**：API Key 不写死在代码里。首次使用请点右上角「设置」填入 `API Key / Base URL / 模型名`，配置仅保存在本地。
>
> **不编造原则**：翻译与总结均通过强约束的 system prompt 抑制幻觉；原文缺失或不确定的内容会显式输出「原文未明确说明」。

## 快速开始

```bash
git clone <本仓库地址>
cd translate                 # ⚠️ Windows + GNU 工具链下，此路径不能含空格，详见文末「常见坑」

# 后端（终端 1）
cd backend && pip install -r requirements.txt && python start.py

# 桌面应用（终端 2，需先装好 Rust 与系统依赖）
npm install && npm run tauri:dev
```

跑起来后，点右上角「设置」填入你自己的 API Key 即可。下面是完整说明。

---

## 目录结构

```
Translate/
├── src-tauri/        # Tauri（Rust）外壳，负责启动 Python 后端
├── src/              # React 前端
│   ├── components/   # PDFViewer / 三大功能面板 / 设置
│   ├── services/     # 后端 HTTP 封装
│   ├── store/        # Zustand 状态（含 settings 持久化）
│   └── types/
├── backend/          # Python FastAPI
│   ├── app/
│   │   ├── api/      # translate / pdf_trans / summary 路由
│   │   ├── services/ # llm.py（统一 LLM 层）/ pdf_service.py（pdf2zh 封装）
│   │   └── models/   # Pydantic schema
│   └── start.py
└── README.md
```

---

## 本地启动

### 前置要求

需要三套运行时 + 各平台的系统依赖。**请先按下表装齐，尤其是「系统依赖」列 —— 这是新手最容易卡住的地方。**

| 运行时 | 版本 | 说明 |
|--------|------|------|
| Node.js | ≥ 18 | 前端构建 |
| Python | ≥ 3.10 | 后端 FastAPI |
| Rust | 最新 stable | Tauri 需要，装 rustup：https://rustup.rs |

**各平台额外的系统依赖：**

- **Windows**
  - WebView2 运行时（Win11 自带；Win10 若无需从微软官网装 Evergreen 版）
  - C 链接器，二选一：
    - **推荐 MSVC**：装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/) 勾选「C++ 生成工具」，然后 `rustup default stable-msvc`。对含空格路径更宽容。
    - **或 GNU 工具链**：`rustup default stable-gnu` + 完整 MinGW-w64（推荐用 [WinLibs](https://winlibs.com/) 或 `winget install BrechtSanders.WinLibs.POSIX.UCRT`，需提供 `gcc/as/dlltool/windres`）。⚠️ 用 GNU 时**项目路径不能含空格**，见文末「常见坑」。
- **macOS**：`xcode-select --install`（提供 clang）
- **Linux（Debian/Ubuntu）**：
  ```bash
  sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
  ```

> 只想快速看前端、不编译桌面壳？跳过 Rust/系统依赖，直接用下面的「方式 B：纯浏览器调试」。

### 1. 启动后端（Python FastAPI）

```bash
cd backend
python -m venv .venv
# Windows
.venv\Scripts\activate
# macOS/Linux
source .venv/bin/activate

pip install -r requirements.txt
python start.py          # 监听 http://127.0.0.1:8765
```

> 想启用「保留排版/公式/图表」的全文翻译，额外安装 pdf2zh：
> ```bash
> pip install pdf2zh
> ```
> 未安装时，全文翻译会自动降级为纯文本翻译，并在界面明确提示。

### 2. 启动前端 / 桌面应用

**方式 A：桌面应用（Tauri，推荐）**

```bash
npm install
npm run tauri:dev
```

Tauri 启动时会自动拉起 `backend/start.py`。若你已手动启动后端（步骤 1），也不冲突（端口相同，二者取其一即可，建议开发期手动启动后端便于看日志）。

**方式 B：纯浏览器调试（不打包桌面）**

```bash
npm install
npm run dev              # 打开 http://localhost:1420
```

浏览器模式下「打开 PDF」会降级为网页文件选择框；桌面模式使用原生对话框。

### 3. 首次使用
1. 右上角「设置」→ 填入 API Key、Base URL（如 `https://api.openai.com/v1` 或你的中转地址）、模型名（如 `gpt-4o-mini`）。
2. 点「测试连接」确认可用 → 保存。
3. 「打开 PDF」选择本地文件即可使用三大功能。

---

## 打包

```bash
npm run tauri:build
```

> 打包发行版时，建议用 PyInstaller 把 `backend` 打成独立可执行文件作为 Tauri sidecar，并在 `tauri.conf.json` 的 `bundle.externalBin` 中登记；MVP 阶段默认直接调用系统 `python`。

## 图标

图标已随仓库提供（`src-tauri/icons/`）。若需替换，用官方命令从一张 ≥512×512 的 PNG 重新生成：

```bash
npm run tauri icon path/to/icon.png
```

## ⚠️ 重要：项目路径不要含空格

在 Windows + GNU 工具链下，若项目绝对路径含空格（例如 `D:\CC Code\...`），
Tauri 构建阶段的 `windres`（编译 Windows 资源/图标）会因 `cc1.exe` 无法解析
带空格的路径而失败，报：

```
cc1.exe: fatal error: ...: No such file or directory
windres: preprocessing failed.
```

**规避方法（任选其一）：**
- 把项目放到无空格路径，如 `D:\code\translate`（最简单，推荐）
- 或改用 MSVC 工具链（安装 VS Build Tools 后 `rustup default stable-msvc`），MSVC 的资源编译器不受空格影响
- 注意：`npm run dev`（纯前端）与后端 `python start.py` 不受此限制，
  仅 `npm run tauri:dev` / `tauri:build`（需编译 Rust）受影响

> 已验证：`cargo check` 在无空格路径下通过（Rust 1.96 GNU 工具链，需完整 MinGW-w64 提供 `as.exe`/`dlltool.exe`/`windres.exe`）。

---

## API 一览

| 功能 | 方法 | 路径 |
|------|------|------|
| 划词翻译 | POST | `/api/translate/text` |
| 配置测试 | POST | `/api/settings/test` |
| 全文翻译启动 | POST | `/api/translate/pdf/start` |
| 全文翻译进度(SSE) | GET | `/api/translate/pdf/progress/{task_id}` |
| 全文翻译结果 | GET | `/api/translate/pdf/result/{task_id}` |
| 文献总结(SSE) | POST | `/api/summary/stream` |
| 健康检查 | GET | `/api/health` |

---

## 已知限制（MVP）

- 全文翻译的排版保真度取决于 pdf2zh；未安装则为纯文本降级。
- 扫描件（图片型 PDF）无法提取文本，总结/降级翻译会提示无可用文本。
- 任务状态存于后端内存，重启后端会丢失进行中的任务。
- 左右页码同步为「就近页」策略，非像素级对齐。

---

## 许可证

本项目基于 [MIT License](LICENSE) 开源。

## 致谢

- 全文翻译思路参考 [PDFMathTranslate / pdf2zh](https://github.com/Byaidu/PDFMathTranslate)
- PDF 渲染基于 [PDF.js](https://mozilla.github.io/pdf.js/)
- 桌面壳基于 [Tauri](https://tauri.app/)
