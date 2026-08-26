"""Export the FastAPI schema deterministically for the committed contract snapshot."""
from __future__ import annotations

import json
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_ROOT))

from app.main import app  # noqa: E402


def main() -> None:
    target = BACKEND_ROOT / "openapi.json"
    encoded = json.dumps(
        app.openapi(),
        ensure_ascii=False,
        indent=2,
        sort_keys=True,
    )
    target.write_bytes(f"{encoded}\n".encode("utf-8"))
    print(f"wrote {target}")


if __name__ == "__main__":
    main()
