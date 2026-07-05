# -*- mode: python ; coding: utf-8 -*-
# PyInstaller 打包配置：把 Python 后端打成单一 exe，作为 Tauri sidecar。
#
# PDF2ZH_EXCLUDE = False（阶段B）：打包 pdf2zh，全文翻译保留排版。
#   依赖 onnxruntime/cv2/pymupdf/babeldoc 等原生库，体积约 200MB+。
# PDF2ZH_EXCLUDE = True（阶段A）：排除 pdf2zh，全文翻译走降级覆盖翻译模式，体积约 58MB。

import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_all

PDF2ZH_EXCLUDE = False  # 阶段B：False=打包 pdf2zh

block_cipher = None

# 阶段A 排除的重依赖；阶段B 仅排除 gradio（仅 GUI 模式用，high_level 不依赖）
heavy_excludes = [
    "pdf2zh", "babeldoc", "gradio", "gradio_pdf", "gradio_client",
    "cv2", "opencv", "onnxruntime", "onnx", "huggingface_hub",
    "tencentcloud", "xinference_client", "ollama", "deepl",
]
stage_b_excludes = ["gradio", "gradio_pdf", "gradio_client"]

# 阶段B：collect pdf2zh 及其原生库依赖。
# 只 collect 含原生 DLL 的包；numpy/huggingface_hub 是纯 Python，
# 交给 PyInstaller 静态分析自然拉入（collect_all 会误收测试数据/CLI，体积爆炸）。
extra_binaries = []
extra_datas = []
extra_hidden = []
if not PDF2ZH_EXCLUDE:
    for pkg in ["pdf2zh", "babeldoc", "onnxruntime", "cv2", "pymupdf", "fitz"]:
        try:
            d, b, h = collect_all(pkg)
            extra_datas += d
            extra_binaries += b
            extra_hidden += h
            print(f"[spec] collect_all {pkg}: {len(d)} datas, {len(b)} bins, {len(h)} hidden")
        except Exception as e:
            print(f"[spec] collect_all {pkg} 失败: {e}")

a = Analysis(
    ["start.py"],
    pathex=[str(Path(SPECPATH).resolve())],
    binaries=extra_binaries,
    datas=extra_datas,
    hiddenimports=[
        "uvicorn.logging",
        "uvicorn.loops.auto",
        "uvicorn.protocols.http.auto",
        "uvicorn.protocols.websockets.auto",
        "uvicorn.protocols.websockets.wsproto_impl",
        "uvicorn.lifespan.on",
        "uvicorn.lifespan.off",
        "multipart",
    ] + extra_hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=heavy_excludes if PDF2ZH_EXCLUDE else stage_b_excludes,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

# reportlab CJK 字体资源
rl_path = Path(sys.prefix, "Lib", "site-packages", "reportlab")
if rl_path.exists():
    a.datas += Tree(str(rl_path), prefix="reportlab")

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
