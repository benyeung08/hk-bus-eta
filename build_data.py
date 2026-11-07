#!/usr/bin/env python3
"""自動產生網站用的路線／車站索引與版本檔。

由 GitHub Actions 每天定時執行（見 .github/workflows/pages.yml），
也可本機執行：python3 scripts/build_data.py

流程：多來源抓取 → 結構校驗 → 精簡成前端需要的欄位 → 內容雜湊當版本號
     → 寫出 data/routeFareList.min.json 與 data/versions.json

設計重點：
* 版本號是「內容」的 SHA-256 前 16 碼，上游沒改就不會觸發前端重載。
* 全部來源失敗時不會中斷部署；既有索引會被保留，前端會自動降級。
* 只用 Python 標準庫，Actions 不需 pip install。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

HKT = timezone(timedelta(hours=8))
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "data"
UA = "hk-bus-eta/1.0 (static site build; +https://github.com)"

# 依序嘗試；前兩個是同一份每日更新資料的正式站台與 GitHub Pages 原始檔。
SOURCES = [
    "https://data.hkbus.app/routeFareList.min.json",
    "https://raw.githubusercontent.com/hkbus/hk-bus-crawling/gh-pages/routeFareList.min.json",
    "https://data.hkbus.app/routeFareList.json",
    "https://raw.githubusercontent.com/hkbus/hk-bus-crawling/gh-pages/routeFareList.json",
]

# 前端 js/data.js 實際會讀的欄位，其餘（holidays / freq / jt / stopMap…）省略以縮小檔案。
ROUTE_FIELDS = (
    "route", "co", "orig", "dest", "fares",
    "stops", "bound", "serviceType", "gtfsId", "nlbId",
)


def log(msg: str, level: str = "notice") -> None:
    prefix = f"::{level} ::" if os.environ.get("GITHUB_ACTIONS") else f"[{level}] "
    print(prefix + msg, flush=True)


def read_bytes(src: str, timeout: int, retries: int) -> bytes:
    """支援 http(s) URL 與本機路徑（--fixture / --source 用）。"""
    if src.startswith(("http://", "https://")):
        last: Exception | None = None
        for attempt in range(retries + 1):
            req = urllib.request.Request(
                src, headers={"User-Agent": UA, "Accept": "application/json"}
            )
            try:
                with urllib.request.urlopen(req, timeout=timeout) as res:
                    raw = res.read()
                if len(raw) < 2000:
                    raise ValueError(f"response too small ({len(raw)} bytes)")
                return raw
            except (urllib.error.URLError, OSError, ValueError) as exc:
                last = exc
                if attempt < retries:
                    time.sleep(2 * (attempt + 1))
        raise RuntimeError(f"{src}: {last}")
    path = Path(src)
    if not path.is_file():
        raise RuntimeError(f"file not found: {src}")
    return path.read_bytes()


def validate(raw: bytes) -> dict:
    """避免抓到 403 頁面、被截斷的 JSON 或結構改版卻照樣部署。"""
    try:
        data = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"invalid JSON: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("root is not an object")
    route_list = data.get("routeList")
    stop_list = data.get("stopList")
    if not isinstance(route_list, dict) or not isinstance(stop_list, dict):
        raise ValueError("missing routeList / stopList")
    if len(route_list) < 100 or len(stop_list) < 100:
        raise ValueError(f"dataset unexpectedly small: {len(route_list)} routes, {len(stop_list)} stops")

    for i, (key, entry) in enumerate(route_list.items()):
        if not isinstance(entry, dict) or not entry.get("route") or not isinstance(entry.get("stops"), dict):
            raise ValueError(f"malformed route entry: {key}")
        if i >= 4:
            break
    for i, (key, entry) in enumerate(stop_list.items()):
        if not isinstance(entry, dict) or not isinstance(entry.get("location"), dict):
            raise ValueError(f"malformed stop entry: {key}")
        if i >= 4:
            break
    return data


def slim(data: dict) -> dict:
    out: dict = {"schema": 1, "routeList": {}, "stopList": {}}

    for key, entry in data["routeList"].items():
        if not isinstance(entry, dict):
            continue
        item = {f: entry[f] for f in ROUTE_FIELDS if entry.get(f) is not None}
        item.setdefault("co", [])
        item.setdefault("stops", {})
        item.setdefault("bound", {})
        item.setdefault("orig", {})
        item.setdefault("dest", {})
        out["routeList"][key] = item

    for key, entry in data["stopList"].items():
        if not isinstance(entry, dict):
            continue
        loc = entry.get("location") or {}
        name = entry.get("name") or {}
        out["stopList"][key] = {
            "location": {
                "lat": loc.get("lat"),
                "lng": loc.get("lng", loc.get("long")),
            },
            "name": {
                "zh": name.get("zh", name.get("tc", name.get("name_tc", ""))),
                "en": name.get("en", name.get("name_en", "")),
            },
        }
    return out


def now_meta() -> dict:
    return {
        "schema": 1,
        "generated_at": datetime.now(HKT).isoformat(timespec="seconds"),
        "generated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def write_json(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(payload)
    tmp.replace(path)


def build(out_dir: Path, sources: list[str], timeout: int, retries: int) -> bool:
    index_path = out_dir / "routeFareList.min.json"
    versions_path = out_dir / "versions.json"
    errors: list[str] = []

    for src in sources:
        try:
            raw = read_bytes(src, timeout, retries)
            data = validate(raw)
            compact = slim(data)
            payload = json.dumps(
                compact, ensure_ascii=False, separators=(",", ":"), sort_keys=True
            ).encode("utf-8")
            meta = now_meta()
            meta.update({
                "status": "ok",
                "version": hashlib.sha256(payload).hexdigest()[:16],
                "source": src,
                "routes": len(compact["routeList"]),
                "stops": len(compact["stopList"]),
                "bytes": len(payload),
            })
            write_json(index_path, payload)
            write_json(versions_path, json.dumps(
                meta, ensure_ascii=False, separators=(",", ":"), indent=None
            ).encode("utf-8"))
            log(f"route data updated: {meta['routes']} routes / {meta['stops']} stops "
                f"/ {meta['bytes']:,} bytes / v{meta['version']} ← {src}")
            return True
        except Exception as exc:  # 換下一個來源
            msg = f"{src} → {exc}"
            errors.append(msg)
            log(msg, "warning")

    # 全部失敗：不中斷部署。既有索引保留；完全沒有索引時才寫 unavailable 標記。
    if not index_path.exists():
        meta = now_meta()
        meta.update({"status": "unavailable", "version": None, "errors": errors})
        write_json(versions_path, json.dumps(
            meta, ensure_ascii=False, separators=(",", ":")
        ).encode("utf-8"))
        log("no index available; wrote unavailable marker (site will fall back)", "warning")
    else:
        log("all sources failed; keeping previously generated index", "warning")
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description="Build HK bus route/stop index")
    ap.add_argument("--out", default=str(DEFAULT_OUT), help="output directory (default: ./data)")
    ap.add_argument("--source", action="append", help="override source(s); repeatable, local path allowed")
    ap.add_argument("--fixture", help="offline test: read this local JSON instead of network")
    ap.add_argument("--timeout", type=int, default=60)
    ap.add_argument("--retries", type=int, default=2)
    ap.add_argument("--strict", action="store_true", help="exit 1 when every source fails")
    args = ap.parse_args()

    sources = args.source or ([args.fixture] if args.fixture else SOURCES)

    ok = build(Path(args.out), sources, args.timeout, args.retries)
    if not ok and args.strict:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
