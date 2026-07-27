"""跨平台 CJK 字体解析。

集中管理"能嵌入 PDF 的中文字体"候选列表，避免在 pdf_service / pdf_edit_service
里重复三份 Windows 硬编码路径。

调用方通常关心两件事：
- `resolve_cjk_font_path()`：拿到第一个存在的字体文件绝对路径（或 None）。
- `iter_cjk_font_candidates()`：需要自己遍历（如带 subfontIndex）时按顺序取候选。

平台探测按 `sys.platform` 分派；未列出的平台落回一个通用列表（fc-match 已知路径 +
用户 Downloads/项目 fonts 目录）。
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from functools import lru_cache
from typing import Iterable, Optional, Tuple

# ---------- 候选列表 ----------

# Windows 系统字体（原三份重复清单的并集，保持覆盖率）
_WINDOWS_CANDIDATES: Tuple[str, ...] = (
    r"C:\Windows\Fonts\msyh.ttc",                     # Microsoft YaHei
    r"C:\Windows\Fonts\simsun.ttc",                   # SimSun
    r"C:\Windows\Fonts\simhei.ttf",                   # SimHei
    r"C:\Windows\Fonts\NotoSansSC-VF.ttf",
    r"C:\Windows\Fonts\Noto Sans SC (TrueType).otf",
    r"C:\Windows\Fonts\STSONG.TTF",
)

# macOS 系统字体
_MACOS_CANDIDATES: Tuple[str, ...] = (
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "/Library/Fonts/Songti.ttc",
    "/System/Library/Fonts/Supplemental/Songti.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
)

# Linux 常见发行版字体（Debian/Ubuntu/Fedora/Arch 主流路径）
_LINUX_CANDIDATES: Tuple[str, ...] = (
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/wqy-microhei/wqy-microhei.ttc",
    "/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/usr/share/fonts/truetype/arphic/uming.ttc",
)


def _platform_candidates() -> Tuple[str, ...]:
    if sys.platform.startswith("win"):
        return _WINDOWS_CANDIDATES
    if sys.platform == "darwin":
        return _MACOS_CANDIDATES
    return _LINUX_CANDIDATES


def _fc_match_cjk() -> Optional[str]:
    """使用 fontconfig 的 fc-match 查询系统 CJK 字体（Linux/macOS 上通常可用）。

    仅在候选清单都不存在时兜底。找不到 fc-match 或返回异常均返回 None。
    """
    fc = shutil.which("fc-match")
    if not fc:
        return None
    try:
        out = subprocess.run(
            [fc, "-f", "%{file}\n", "sans-serif:lang=zh"],
            capture_output=True, text=True, timeout=3, check=False,
        )
        path = (out.stdout or "").strip().splitlines()[0].strip() if out.stdout else ""
        if path and os.path.exists(path):
            return path
    except Exception:  # noqa: BLE001
        return None
    return None


def iter_cjk_font_candidates() -> Iterable[str]:
    """按平台顺序 yield 候选路径（不过滤存在性，供需要索引/subfont 的场景使用）。"""
    for p in _platform_candidates():
        yield p


@lru_cache(maxsize=1)
def resolve_cjk_font_path() -> Optional[str]:
    """返回第一个存在的中文字体文件路径；找不到返回 None。

    使用 lru_cache 缓存首次成功结果，避免热路径重复 stat。
    """
    for p in _platform_candidates():
        if os.path.exists(p):
            return p
    # 兜底：fc-match（Linux/macOS）
    return _fc_match_cjk()


def clear_cache() -> None:
    """清理缓存（测试或用户刚安装字体时使用）。"""
    resolve_cjk_font_path.cache_clear()
