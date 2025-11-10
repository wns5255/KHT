# -*- coding: utf-8 -*-
"""
KTrip RAG Service (FastAPI, cleaned)
--------------------------------
Endpoints
- GET  /healthz
- GET  /api/actor?name=배우
- GET  /api/dramaMeta?title=작품명&kind=drama|film
- POST /api/chat        { mode, keyword, query?, kind?, want_itinerary?, refresh? }
- POST /generate        (구버전 호환: /api/chat과 동일 응답)
- GET  /api/stream      (SSE: csv_refresh_start / csv_stage / csv_refresh_done / csv_refresh_fail / csv_refresh_skip)
- GET  /api/tour/nearby
- GET  /api/youtube

Run:
  pip install fastapi uvicorn requests beautifulsoup4 lxml scikit-learn numpy
  python server.py --server --port 4000
"""

from __future__ import annotations

import os
import re
import csv
import io
import json
import hashlib
import asyncio
import subprocess
import sys
from datetime import datetime, timedelta
from threading import Lock
from typing import Any, Dict, List, Optional
import urllib.parse

import numpy as np
import requests
from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sklearn.cluster import DBSCAN
import heapq
from collections import defaultdict
from math import radians, sin, cos, asin, sqrt

# ===== Repo deps =====
from actor_mode_crawler_and_aggregator import load_gazetteer, get_filmography
from namu_drama_crawler import crawl_one, build_namu_url

# =============================================================================
# 기본 설정
# =============================================================================
CSV_PATH      = os.environ.get("CSV_PATH", "drama_list.csv")
CSV_TITLE_COL = os.environ.get("CSV_TITLE_COL")
CSV_LAT_COL   = os.environ.get("CSV_LAT_COL")
CSV_LNG_COL   = os.environ.get("CSV_LNG_COL")

CACHE_DIR         = os.environ.get("CACHE_DIR", "./cache")
SEARCH_LOG        = os.environ.get("SEARCH_LOG", "search_log.json")
META_TTL_DAYS     = int(os.environ.get("META_TTL_DAYS", "7"))
REFRESH_TTL_DAYS  = int(os.environ.get("REFRESH_TTL_DAYS", "7"))
PORT              = int(os.environ.get("PORT", "4000"))
CORS_ALLOW_ORIG   = os.environ.get("CORS_ALLOW_ORIG", "*")

# 코스(세밀) 군집 반경/최소 포인트
COURSE_EPS_KM_SMALL = float(os.environ.get("COURSE_EPS_KM_SMALL", "8"))
COURSE_MIN_SAMPLES  = int(os.environ.get("COURSE_MIN_SAMPLES", "1"))

os.makedirs(CACHE_DIR, exist_ok=True)

# === [추가] import들 상단에
import os, json, hashlib
from collections import OrderedDict
from typing import List, Dict
from fastapi import HTTPException
from pydantic import BaseModel
from openai import OpenAI
import json, re

from concurrent.futures import ThreadPoolExecutor, as_completed

EXEC = ThreadPoolExecutor(max_workers=4)  # 필요하면 3~6 사이에서 조정
_GROUP_CHAR_LIMIT = 12000  # 한 번에 보낼 총 글자 기준 늘리기(모델 여유 많음)

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "").strip()
if not OPENAI_API_KEY:
    raise RuntimeError("OPENAI_API_KEY not set")
client = OpenAI(api_key=OPENAI_API_KEY)

_LANG_MAP = {"en":"English","jp":"Japanese","ch":"Chinese"}
_SYSTEM_PROMPT = (
  "You are a professional translator. Translate each item to the target language. "
  "Return ONLY JSON that matches the provided schema. Keep names/numbers/units."
)
_MAX_OUT = 4096
_GROUP_CHAR_LIMIT = 5500  # 한 번에 보낼 총 문자 기준(안정 구간)

class BotContext(BaseModel):
    title: Optional[str] = ""        # 드라마 제목
    year_place: Optional[str] = ""   # "연도 · 장소" 이런 표시
    place: Optional[str] = ""        # 장소명
    addr: Optional[str] = ""         # 주소
    name: Optional[str] = ""         # 인물/등장인물
    exp: Optional[str] = ""          # 설명
    ref: Optional[str] = ""          # 출처/채널 등

class BotReq(BaseModel):
    question: str
    context: Optional[BotContext] = None


# --- 매우 단순한 LRU 캐시(프로세스 메모리) ---
class LRU(OrderedDict):
    def __init__(self, cap=5000):
        super().__init__(); self.cap=cap
    def get(self, k): return super().get(k)
    def put(self, k, v):
        if k in self: del self[k]
        super().update({k:v})
        if len(self)>self.cap: self.popitem(last=False)

_tx_cache = LRU(8000)  # (to, sha1(text)) -> translation

def _h(s:str)->str:
    return hashlib.sha1(s.encode("utf-8")).hexdigest()

def _pack(strings: List[str]) -> List[List[str]]:
    """총 글자 수로 묶음 → 왕복 수 최소화"""
    groups, cur, n = [], [], 0
    for s in strings:
        L = len(s)
        if n and n + L > _GROUP_CHAR_LIMIT:
            groups.append(cur); cur=[]; n=0
        cur.append(s); n += L
    if cur: groups.append(cur)
    return groups

def _translate_group_json(group: list[str], to_code: str) -> list[str]:
    target = _LANG_MAP[to_code]
    system = (
        "Translate each string to the target language. "
        'Return ONLY: {"translations": ["...", ...]}'
    )
    user = (
        f"Target: {target}\n"
        "Keep order and length of the array the same.\n" +
        json.dumps(group, ensure_ascii=False)
    )
    r = client.responses.create(
        model="gpt-4o-mini",
        temperature=0,
        max_output_tokens=_MAX_OUT,
        input=[{"role":"system","content":system},{"role":"user","content":user}],
    )

    # 1) 원문 텍스트 추출
    txt = (getattr(r, "output_text", None) or "").strip()

    # 2) JSON만 발췌(혹시 앞뒤로 잡음이 섞여 나오는 경우 대비)
    def _extract_json(s: str):
        start = s.find("{")
        end   = s.rfind("}")
        if start != -1 and end != -1 and end > start:
            chunk = s[start:end+1]
            return json.loads(chunk)
        # 아주 드물게 배열만 올 때 대비
        if "[" in s and "]" in s:
            arr = s[s.find("["): s.rfind("]")+1]
            return {"translations": json.loads(arr)}
        raise ValueError("no json block")

    try:
        data = _extract_json(txt)
        out = data.get("translations", [])
    except Exception:
        out = []

    # 길이 불일치나 파싱 실패 시, 보수적으로 단건 호출로 보정
    if len(out) != len(group):
        fixed = []
        for s in group:
            rr = client.responses.create(
                model="gpt-4o-mini",
                temperature=0,
                max_output_tokens=1024,
                input=[
                    {"role":"system","content":"Return ONLY the translation."},
                    {"role":"user","content":f"Translate to {target}:\n{s}"},
                ],
            )
            fixed.append((getattr(rr, "output_text", "") or "").strip())
        return fixed

    return [ (t or "").strip() for t in out ]

def translate_bulk_with_cache(texts: List[str], to_code: str) -> List[str]:
    # 1) 중복 압축
    uniq: Dict[str, List[int]] = {}
    for i, s in enumerate(texts):
        uniq.setdefault(s, []).append(i)

    # 2) 캐시/DB 적중 분리
    misses = []
    miss_keys = []
    for u in uniq.keys():
        k = (to_code, _h(u))
        hit = _cache_get(k)  # 아래 2) 참고
        if hit is None:
            misses.append(u); miss_keys.append(k)

    # 3) 미번역 → 그룹핑
    groups = _pack(misses)  # _GROUP_CHAR_LIMIT 기준으로 묶음

    # 4) 병렬 요청
    futs = [(g, EXEC.submit(_translate_group_json, g, to_code)) for g in groups]
    for g, fut in futs:
        outs = fut.result()
        for src, out in zip(g, outs):
            _cache_put((to_code, _h(src)), out, src)

    # 5) 원순서 재조립
    result = [""] * len(texts)
    for u, idxs in uniq.items():
        v = _cache_get((to_code, _h(u))) or ""
        for i in idxs: result[i] = v
    return result

# ---------- 스키마 & 라우트 ----------
class TranslateReq(BaseModel):
    to: str                 # 'en' | 'jp' | 'ch'
    texts: List[str]

import sqlite3, threading
_db_lock = threading.Lock()
_db = sqlite3.connect('tx_cache.sqlite3', check_same_thread=False)
_db.execute("""
CREATE TABLE IF NOT EXISTS tx (
  lang TEXT, sha TEXT, src TEXT, dst TEXT,
  PRIMARY KEY (lang, sha)
)
""")
_db.commit()

def _db_get(lang, sha):
    with _db_lock:
        row = _db.execute("SELECT dst FROM tx WHERE lang=? AND sha=?", (lang, sha)).fetchone()
        return row[0] if row else None

def _db_put(lang, sha, src, dst):
    with _db_lock:
        _db.execute("INSERT OR REPLACE INTO tx (lang,sha,src,dst) VALUES (?,?,?,?)", (lang, sha, src, dst))
        _db.commit()

# 기존 LRU 캐시(_tx_cache)와 함께 쓰는 헬퍼
def _cache_get(key):
    to_code, sha = key
    hit = _tx_cache.get(key)
    if hit is not None: return hit
    hit = _db_get(to_code, sha)
    if hit is not None:
        _tx_cache.put(key, hit)
        return hit
    return None

def _cache_put(key, value, src=None):
    to_code, sha = key
    _tx_cache.put(key, value)
    if src is not None:
        _db_put(to_code, sha, src, value)


# =============================================================================
# 공통 유틸
# =============================================================================
def _now_iso() -> str:
    return datetime.utcnow().isoformat() + "Z"

def _is_fresh(ts_iso: str, ttl_days: int) -> bool:
    try:
        dt = datetime.fromisoformat(ts_iso.replace("Z", ""))
        return (datetime.utcnow() - dt) < timedelta(days=ttl_days)
    except Exception:
        return False

def norm_title(s: str) -> str:
    """작품명 정규화(강화): 공백/기호 제거 + 시즌/파트/편/부/말미 숫자 제거 + 소문자"""
    s = (s or "").lower()

    # 괄호 문자 제거
    s = re.sub(r"[(){}\[\]〈〉《》「」『』【】]", "", s)

    # 시즌/파트/편/부/회 표기 제거 (공백 유무 모두 허용)
    s = re.sub(r"(시즌|season)\s*\d+", "", s, flags=re.IGNORECASE)
    s = re.sub(r"(파트|part)\s*\d+",  "", s, flags=re.IGNORECASE)
    s = re.sub(r"\d+\s*(편|부|회)\b",  "", s)

    # 구분자/공백 제거
    s = re.sub(r"[\s·\.\-_:~]+", "", s)

    # 맨 끝의 숫자(예: 오징어게임2)도 제거
    s = re.sub(r"\d+$", "", s)

    return s.strip()

def as_float(x) -> Optional[float]:
    try:
        if x is None:
            return None
        v = float(x)
        if np.isnan(v):
            return None
        return v
    except Exception:
        return None

def _haversine_km(a, b) -> float:
    lat1, lon1 = a; lat2, lon2 = b
    lat1, lon1, lat2, lon2 = map(radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1; dlon = lon2 - lon1
    h = sin(dlat/2)**2 + cos(lat1)*cos(lat2)*sin(dlon/2)**2
    return 2 * 6371.0 * asin(sqrt(h))

# =============================================================================
# YouTube 캐시 + API
# =============================================================================
YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "").strip()
YT_CACHE_CSV      = os.environ.get("YT_CACHE_CSV", os.path.join(CACHE_DIR, "youtube_search_cache.csv"))
YT_CACHE_TTL_DAYS = int(os.environ.get("YT_CACHE_TTL_DAYS", "7"))
_yt_cache_lock    = Lock()

def _ensure_yt_cache_file():
    os.makedirs(os.path.dirname(YT_CACHE_CSV), exist_ok=True)
    if not os.path.exists(YT_CACHE_CSV):
        with open(YT_CACHE_CSV, "w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow(["q", "updated_at", "items_json"])

def _read_yt_cache(q_norm: str):
    if not os.path.exists(YT_CACHE_CSV):
        return None
    with open(YT_CACHE_CSV, "r", newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            if row.get("q") == q_norm:
                try:
                    items = json.loads(row.get("items_json") or "[]")
                except Exception:
                    items = []
                return {"items": items, "updated_at": row.get("updated_at")}
    return None

def _write_yt_cache(q_norm: str, items: list):
    tmp = YT_CACHE_CSV + ".tmp"
    rows = []
    if os.path.exists(YT_CACHE_CSV):
        with open(YT_CACHE_CSV, "r", newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
    written = False
    for row in rows:
        if row.get("q") == q_norm:
            row["updated_at"] = _now_iso()
            row["items_json"] = json.dumps(items, ensure_ascii=False)
            written = True
            break
    if not written:
        rows.append({"q": q_norm, "updated_at": _now_iso(), "items_json": json.dumps(items, ensure_ascii=False)})
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["q", "updated_at", "items_json"])
        w.writeheader()
        for row in rows:
            w.writerow(row)
    os.replace(tmp, YT_CACHE_CSV)

def _yt_search_api(q: str, max_results: int = 8) -> list:
    if not YOUTUBE_API_KEY:
        raise RuntimeError("YOUTUBE_API_KEY not set")
    params = {
        "key": YOUTUBE_API_KEY,
        "part": "snippet",
        "q": q,
        "type": "video",
        "maxResults": str(max(1, min(max_results, 15))),
        "regionCode": "KR",
        "relevanceLanguage": "ko",
        "videoEmbeddable": "true",
        "safeSearch": "moderate",
        "order": "relevance",
    }
    url = "https://www.googleapis.com/youtube/v3/search?" + urllib.parse.urlencode(params)
    r = requests.get(url, timeout=5)
    j = r.json()
    if r.status_code != 200 or "error" in j:
        msg = j.get("error", {}).get("message", f"HTTP {r.status_code}")
        raise RuntimeError(msg)

    out = []
    for it in j.get("items", []):
        vid = (it.get("id") or {}).get("videoId")
        sn  = it.get("snippet") or {}
        if not vid:
            continue
        thumb = (sn.get("thumbnails") or {}).get("high") or (sn.get("thumbnails") or {}).get("default") or {}
        out.append({
            "id": vid,
            "title": sn.get("title"),
            "channel": sn.get("channelTitle"),
            "publishedAt": sn.get("publishedAt"),
            "thumb": thumb.get("url")
        })
    return out

# =============================================================================
# TourAPI (서버에서만 호출) + 캐시
# =============================================================================
def _decode_service_key(k: str) -> str:
    """이중 디코딩까지 안전 처리."""
    if not k:
        return k
    k1 = urllib.parse.unquote(k)
    k2 = urllib.parse.unquote(k1)
    return k2 if k2 != k1 else k1

TOURAPI_KEY_RAW = os.environ.get("TOURAPI_KEY", "")
TOURAPI_KEY = _decode_service_key(TOURAPI_KEY_RAW).strip()
TOURAPI_FORCE_HTTP  = os.environ.get("TOURAPI_FORCE_HTTP", "1") == "1"   # 기본값 HTTP 강제
TOURAPI_TIMEOUT_SEC = float(os.environ.get("TOURAPI_TIMEOUT", "8"))
TOURAPI_CACHE_CSV   = os.path.join(CACHE_DIR, "tourapi_cache.csv")
TOURAPI_TTL_DAYS    = int(os.environ.get("TOURAPI_TTL_DAYS", "7"))
_tour_cache_lock    = Lock()

def _ensure_tour_cache_file():
    os.makedirs(os.path.dirname(TOURAPI_CACHE_CSV), exist_ok=True)
    if not os.path.exists(TOURAPI_CACHE_CSV):
        with open(TOURAPI_CACHE_CSV, "w", newline="", encoding="utf-8") as f:
            csv.writer(f).writerow(["key", "updated_at", "items_json"])

def _tour_cache_read(key: str):
    if not os.path.exists(TOURAPI_CACHE_CSV):
        return None
    with open(TOURAPI_CACHE_CSV, "r", newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            if row.get("key") == key:
                try:
                    items = json.loads(row.get("items_json") or "[]")
                except Exception:
                    items = []
                return {"items": items, "updated_at": row.get("updated_at")}
    return None

def _tour_cache_write(key: str, items: list):
    tmp = TOURAPI_CACHE_CSV + ".tmp"
    rows = []
    if os.path.exists(TOURAPI_CACHE_CSV):
        with open(TOURAPI_CACHE_CSV, "r", newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
    written = False
    for row in rows:
        if row.get("key") == key:
            row["updated_at"] = _now_iso()
            row["items_json"] = json.dumps(items, ensure_ascii=False)
            written = True
            break
    if not written:
        rows.append({"key": key, "updated_at": _now_iso(), "items_json": json.dumps(items, ensure_ascii=False)})
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["key", "updated_at", "items_json"])
        w.writeheader()
        for row in rows:
            w.writerow(row)
    os.replace(tmp, TOURAPI_CACHE_CSV)

def _tour_bases():
    https = [
        "https://apis.data.go.kr/B551011/KorService2",
        "https://apis.data.go.kr/B551011/KorService1",
    ]
    http = [
        "http://apis.data.go.kr/B551011/KorService2",
        "http://apis.data.go.kr/B551011/KorService1",
    ]
    return (http + https) if TOURAPI_FORCE_HTTP else (https + http)

def _tour_normalize_items(items: list):
    """TourAPI item 리스트를 {title, addr, lat, lng, cid, ctype, thumb, dist_km}로 통일."""
    out = []
    for it in items or []:
        lat = it.get("mapy") or it.get("mapY") or it.get("mapyWgs84")
        lng = it.get("mapx") or it.get("mapX") or it.get("mapxWgs84")
        if lat is None or lng is None:
            continue
        try:
            latf = float(lat); lngf = float(lng)
        except Exception:
            continue
        out.append({
            "title": it.get("title") or it.get("addr1") or "",
            "addr": it.get("addr1") or "",
            "lat": latf,
            "lng": lngf,
            "cid": it.get("contentid"),
            "ctype": it.get("contenttypeid"),
            "thumb": it.get("firstimage") or it.get("firstimage2")
        })
    return out

def _tour_location_based_once(base: str, lat: float, lng: float, radius: int, type_id: int, num: int):
    """단일 base에서 locationBased 호출."""
    is_v2 = base.endswith("KorService2")
    path = "locationBasedList2" if is_v2 else "locationBasedList1"
    url  = f"{base}/{path}"

    params = {
        "serviceKey": TOURAPI_KEY,  # 디코딩된 값
        "MobileOS": "ETC",
        "MobileApp": "KTrip",
        "_type": "json",
        "mapY": f"{lat}",
        "mapX": f"{lng}",
        "radius": str(int(radius)),
        "arrange": "E",
        "numOfRows": str(int(num)),
        "pageNo": "1",
        "contentTypeId": str(int(type_id)),
    }
    if not is_v2:
        params["listYN"] = "Y"   # v1 전용

    try:
        r = requests.get(url, params=params, timeout=TOURAPI_TIMEOUT_SEC)
    except requests.exceptions.SSLError as e:
        return None, f"ssl_error: {e}"
    except Exception as e:
        return None, f"http_error: {e}"

    ctype = (r.headers.get("content-type") or "").lower()
    if "json" not in ctype:
        return None, f"non_json: {r.status_code}"

    try:
        j = r.json()
    except Exception as e:
        return None, f"json_parse_error: {e}"

    head = (((j or {}).get("response") or {}).get("header") or {})
    code = head.get("resultCode")
    msg  = head.get("resultMsg", "")
    if code != "0000":
        # v2에 listYN 잘못 붙었을 때 자동 치유
        if code == "10" and "listYN" in (msg or "") and is_v2 and ("listYN" in params):
            params.pop("listYN", None)
            try:
                r2 = requests.get(url, params=params, timeout=TOURAPI_TIMEOUT_SEC)
                j2 = r2.json()
                head2 = (((j2 or {}).get("response") or {}).get("header") or {})
                if head2.get("resultCode") == "0000":
                    items = ((((j2.get("response") or {}).get("body") or {}).get("items") or {}).get("item") or [])
                    return _tour_normalize_items(items), None
            except Exception as e:
                return None, f"retry_after_listyn_fix_fail: {e}"
        return None, f"bad_code:{code} msg:{msg}"

    items = ((((j.get("response") or {}).get("body") or {}).get("items") or {}).get("item") or [])
    return _tour_normalize_items(items), None

def _tour_location_based(lat: float, lng: float, radius: int, type_id: int, num: int):
    """base 후보 순회하며 성공하는 첫 결과 반환(+거리 계산/정렬)."""
    last_err = None
    for base in _tour_bases():
        items, err = _tour_location_based_once(base, lat, lng, radius, type_id, num)
        if items is not None:
            for p in items:
                try:
                    p["dist_km"] = round(_haversine_km((lat, lng), (p["lat"], p["lng"])), 2)
                except Exception:
                    p["dist_km"] = None
            items.sort(key=lambda x: (x.get("dist_km") if x.get("dist_km") is not None else 9e9, x.get("title") or ""))
            return items
        last_err = err
    raise RuntimeError(last_err or "tourapi_all_failed")

def _tour_type_ids(type_param: str):
    t = (type_param or "all").strip().lower()
    if t in ("12", "attraction", "명소", "관광지"):
        return [12]
    if t in ("32", "hotel", "숙박"):
        return [32]
    if t in ("39", "food", "음식"):
        return [39]
    if t in ("all", "전체"):
        return [12, 32, 39]
    try:
        return [int(t)]
    except Exception:
        return [12, 32, 39]

# =============================================================================
# SSE 브로드캐스트
# =============================================================================
SUBSCRIBERS: set[asyncio.Queue] = set()

def _broadcast(event: dict):
    for q in list(SUBSCRIBERS):
        try:
            q.put_nowait(event)
        except Exception:
            pass

# =============================================================================
# Gazetteer (CSV)
# =============================================================================
GAZ_IDX = None

def ensure_gazetteer():
    """CSV 로딩(+제목 정규화 키로 병합)"""
    global GAZ_IDX
    if not os.path.exists(CSV_PATH):
        GAZ_IDX = {}
        return
    try:
        raw = load_gazetteer(
            CSV_PATH,
            title_col=CSV_TITLE_COL,
            lat_col=CSV_LAT_COL,
            lng_col=CSV_LNG_COL
        )
        merged = {}
        for title_key, rows in (raw or {}).items():
            nk = norm_title(title_key)
            merged.setdefault(nk, []).extend(rows)
        GAZ_IDX = merged
        print(f"[gazetteer] loaded: {CSV_PATH} (norm-keys={len(GAZ_IDX)})")
    except Exception as e:
        print(f"[gazetteer] load failed: {e}")
        GAZ_IDX = {}


def search_locations_via_gazetteer(drama_title: str) -> List[Dict[str, Any]]:
    """정규화된 작품명 키로 핀 목록 리턴"""
    ensure_gazetteer()
    if not GAZ_IDX:
        return []

    norm_q = norm_title(drama_title)
    rows = GAZ_IDX.get(norm_q, [])
    hits: List[Dict[str, Any]] = []
    for r in rows:
        row = r.get("row", {}) if isinstance(r, dict) else {}
        hits.append({
            "title": drama_title,
            "place_name": row.get("PLACE_NM") or row.get("place") or "",
            "address": row.get("ADDR") or "",
            "lat": as_float(r.get("lat")),
            "lng": as_float(r.get("lng")),
            "media_type": row.get("MEDIA_TY"),
            "place_type": row.get("PLACE_TY"),
            "tel": row.get("TEL_NO"),
            "title_src": r.get("title"),
        })
    return hits


# =============================================================================
# 검색 로그 & CSV 최신화 파이프라인
# =============================================================================
def _load_search_log() -> dict:
    if os.path.exists(SEARCH_LOG):
        try:
            with open(SEARCH_LOG, encoding="utf-8") as f:
                return json.load(f)
        except json.JSONDecodeError:
            print("[WARN] search_log.json 손상 → 초기화")
            return {}
    return {}

def save_search_log(log: dict):
    with open(SEARCH_LOG, "w", encoding="utf-8") as f:
        json.dump(log, f, ensure_ascii=False, indent=2)

_REFRESH_LOCK = Lock()
_REFRESH_RUNNING: set[str] = set()

def ensure_fresh_data(title: str, refresh_requested: bool = False) -> None:
    """
    refresh_requested=True 일 때만 '갱신 고려'.
    단, TTL 내(REFRESH_TTL_DAYS)에는 무조건 스킵.
    """
    if not refresh_requested:
        return  # 갱신 요청이 아예 없으면 조용히 종료

    key = norm_title(title)
    now_iso = _now_iso()

    # TTL 체크: TTL 내면 무조건 스킵
    log = _load_search_log()
    last = log.get(key)
    if last and _is_fresh(last, REFRESH_TTL_DAYS):
        _broadcast({"type": "csv_refresh_skip", "title": title, "ts": now_iso, "reason": "fresh"})
        return

    # 동시 실행 방지
    with _REFRESH_LOCK:
        if key in _REFRESH_RUNNING:
            _broadcast({"type": "csv_refresh_skip", "title": title, "ts": now_iso, "reason": "in_flight"})
            return
        _REFRESH_RUNNING.add(key)

    try:
        _broadcast({"type": "csv_refresh_start", "title": title, "ts": now_iso})

        proc = subprocess.Popen(
            [sys.executable, "main_pipeline.py", title],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            universal_newlines=True,
        )

        stage_sent = set()
        stage_re = re.compile(r"([1-4])\s*단계")

        try:
            for line in iter(proc.stdout.readline, ""):
                if not line:
                    break
                sys.stdout.write(line)
                m = stage_re.search(line)
                if m:
                    stage = int(m.group(1))
                    if stage not in stage_sent:
                        stage_sent.add(stage)
                        _broadcast({
                            "type": "csv_stage",
                            "title": title,
                            "stage": stage,
                            "label": line.strip(),
                            "ts": _now_iso(),
                        })
            proc.wait()
        finally:
            if proc and proc.poll() is None:
                proc.terminate()

        if proc.returncode and proc.returncode != 0:
            _broadcast({"type": "csv_refresh_fail", "title": title, "code": proc.returncode, "ts": _now_iso()})
            return

        # CSV 재로딩 + 로그 저장(정규화 키)
        global GAZ_IDX
        GAZ_IDX = None
        ensure_gazetteer()
        log[key] = datetime.utcnow().isoformat()
        save_search_log(log)

        _broadcast({"type": "csv_stage", "title": title, "stage": 5, "label": "[INFO] CSV 업데이트 완료 및 재로딩", "ts": _now_iso()})
        _broadcast({"type": "csv_refresh_done", "title": title, "ts": _now_iso()})
    finally:
        with _REFRESH_LOCK:
            _REFRESH_RUNNING.discard(key)

# =============================================================================
# 맵 군집 / 코스 빌더
# =============================================================================
def cluster_by_radius(pins, eps_km=60.0, min_samples=1):
    coords = [(p["lat"], p["lng"]) for p in pins if p.get("lat") is not None and p.get("lng") is not None]
    if not coords:
        return pins, {}
    X = np.radians(np.array(coords))
    model = DBSCAN(eps=eps_km/6371.0, min_samples=min_samples, metric="haversine")
    labels = model.fit_predict(X)
    j = 0
    for p in pins:
        if p.get("lat") is not None and p.get("lng") is not None:
            p["cluster"] = int(labels[j]) if labels[j] >= 0 else -1
            j += 1
        else:
            p["cluster"] = -1
    clmap = {}
    for p in pins:
        clmap.setdefault(p["cluster"], []).append(p)
    return pins, clmap

def _kNN_distances(points, k=1):
    dists = []
    for i, p in enumerate(points):
        cand = []
        for j, q in enumerate(points):
            if i == j:
                continue
            d = _haversine_km((p['lat'], p['lng']), (q['lat'], q['lng']))
            cand.append(d)
        cand.sort()
        if cand:
            dists.append(cand[min(k-1, len(cand)-1)])
    return dists

def _auto_eps_km(points):
    if len(points) < 3:
        return 6.0
    nn = _kNN_distances(points, k=1)
    if not nn:
        return 6.0
    med = float(np.median(nn))
    eps = med * 4.0
    return max(1.2, min(8.0, eps))

def _mst_edges_prim(points):
    n = len(points)
    if n <= 1:
        return []
    def dist(i, j):
        pi, pj = points[i], points[j]
        return _haversine_km((pi['lat'], pi['lng']), (pj['lat'], pj['lng']))
    visited = [False]*n
    visited[0] = True
    pq = []
    for j in range(1, n):
        heapq.heappush(pq, (dist(0, j), 0, j))
    edges = []
    while pq and len(edges) < n-1:
        d, i, j = heapq.heappop(pq)
        if visited[i] and visited[j]:
            continue
        u = j if not visited[j] else i
        v = i if u == j else j
        if visited[u]:
            continue
        visited[u] = True
        edges.append((i, j, d))
        for k in range(n):
            if not visited[k]:
                heapq.heappush(pq, (dist(u, k), u, k))
    return edges

def _split_by_long_edges(points, mst_edges):
    if not mst_edges:
        return [list(range(len(points)))]
    lens = [d for (_,_,d) in mst_edges]
    med = float(np.median(lens)) if lens else 0.0
    thr = max(4.0, med*4.0)
    g = defaultdict(list)
    for i, j, d in mst_edges:
        if d > thr:
            continue
        g[i].append(j)
        g[j].append(i)
    comps, seen = [], set()
    for s in range(len(points)):
        if s in seen:
            continue
        if s not in g and len(points) > 1:
            continue
        q = [s]
        seen.add(s)
        comp = []
        while q:
            u = q.pop()
            comp.append(u)
            for v in g[u]:
                if v not in seen:
                    seen.add(v)
                    q.append(v)
        if comp:
            comps.append(comp)
    if not comps and len(points) >= 2:
        i, j, _ = min(mst_edges, key=lambda x: x[2])
        comps = [[i, j]]
    return comps or [list(range(len(points)))]

def _cheapest_insertion_path_with_2opt(items):
    n = len(items)
    if n <= 1:
        return [items[0]['id']] if n == 1 else []

    def D(i, j):
        a, b = items[i], items[j]
        return _haversine_km((a['lat'], a['lng']), (b['lat'], b['lng']))

    far = (-1.0, 0, 1)
    for i in range(n):
        for j in range(i+1, n):
            dij = D(i, j)
            if dij > far[0]:
                far = (dij, i, j)
    path = [far[1], far[2]]
    unvis = set(range(n)) - set(path)

    while unvis:
        best = (1e18, None, None)  # (delta, where, k)
        for k in unvis:
            delta_front = D(k, path[0])
            if delta_front < best[0]:
                best = (delta_front, ('front', 0), k)
            delta_back = D(path[-1], k)
            if delta_back < best[0]:
                best = (delta_back, ('back', len(path)), k)
            for i in range(len(path)-1):
                a, b = path[i], path[i+1]
                delta = D(a, k) + D(k, b) - D(a, b)
                if delta < best[0]:
                    best = (delta, ('mid', i+1), k)
        _, where, k = best
        if where[0] == 'front':
            path.insert(0, k)
        elif where[0] == 'back':
            path.append(k)
        else:
            path.insert(where[1], k)
        unvis.remove(k)

    def seg_len_idx(i, j):
        a, b = items[path[i]], items[path[j]]
        return _haversine_km((a['lat'], a['lng']), (b['lat'], b['lng']))

    improved, loop = True, 0
    while improved and loop < 80:
        improved = False; loop += 1
        for i in range(1, len(path)-2):
            for j in range(i+1, len(path)-1):
                before = seg_len_idx(i-1, i) + seg_len_idx(j, j+1)
                after  = seg_len_idx(i-1, j) + seg_len_idx(i, j+1)
                if after + 1e-9 < before:
                    path[i:j+1] = reversed(path[i:j+1])
                    improved = True
    return [items[k]['id'] for k in path]

def _guess_course_title(items):
    toks_list = []
    for it in items:
        addr = (it.get('subtitle') or '').strip()
        toks = [t for t in addr.split() if t]
        toks_list.append(toks[:3])
    if not toks_list:
        return "코스"
    from collections import Counter
    c1 = Counter(t[0] for t in toks_list if len(t) >= 1)
    city = c1.most_common(1)[0][0] if c1 else "코스"
    c2 = Counter((t[0], t[1]) for t in toks_list if len(t) >= 2)
    if c2 and c2.most_common(1)[0][1] >= 2:
        city = " ".join(c2.most_common(1)[0][0])
    return f"{city} 코스"

def build_courses_from_pins(pins, eps_km_small=10.0, min_samples=2):
    valid = [p for p in pins if p.get("lat") is not None and p.get("lng") is not None]
    if not valid:
        return []
    if eps_km_small is None:
        eps_km_small = _auto_eps_km(valid)

    X = np.radians(np.array([(p['lat'], p['lng']) for p in valid]))
    model = DBSCAN(eps=eps_km_small/6371.0, min_samples=min_samples, metric="haversine")
    labels = model.fit_predict(X)

    label_to_items: dict[int, list] = defaultdict(list)
    for p, lb in zip(valid, labels):
        if lb < 0:
            continue
        label_to_items[int(lb)].append(p)

    courses = []
    for gid, items in label_to_items.items():
        if len(items) < 2:
            continue
        idx_map = {i: items[i] for i in range(len(items))}
        mst = _mst_edges_prim(items)
        subs = _split_by_long_edges(items, mst)
        for sub in subs:
            sub_items = [idx_map[i] for i in sub]
            if len(sub_items) < 2:
                continue
            order_ids = _cheapest_insertion_path_with_2opt(sub_items)
            id2 = {p['id']: p for p in sub_items}
            path, total = [], 0.0
            for a, b in zip(order_ids, order_ids[1:]):
                pa, pb = id2[a], id2[b]
                total += _haversine_km((pa['lat'], pa['lng']), (pb['lat'], pb['lng']))
                path.append([pa['lat'], pa['lng']])
            last = id2[order_ids[-1]]
            path.append([last['lat'], last['lng']])

            cx = sum(p['lat'] for p in sub_items)/len(sub_items)
            cy = sum(p['lng'] for p in sub_items)/len(sub_items)
            title = _guess_course_title(sub_items)

            courses.append({
                "id": f"course_{gid}_{len(courses)}",
                "title": title,
                "center": {"lat": cx, "lng": cy},
                "spots": order_ids,
                "distance_km": round(total, 1),
                "polyline": path
            })
    courses.sort(key=lambda c: (c['center']['lat'], c['center']['lng']))
    return courses

import uuid
from jose import jwt, JWTError
from passlib.hash import bcrypt
from fastapi import Depends, HTTPException, status, Request, Response, Body, Path

DATA_DIR = os.environ.get("DATA_DIR", "./data")
os.makedirs(DATA_DIR, exist_ok=True)

AUTH_SECRET = os.environ.get("AUTH_SECRET", "PLEASE_CHANGE_ME")
AUTH_ALGO   = "HS256"
AUTH_TTL_DAYS = int(os.environ.get("AUTH_TOKEN_TTL_DAYS", "30"))

USERS_CSV = os.path.join(DATA_DIR, "users.csv")
_user_locks: dict[str, Lock] = {}
def _lock_for(uid: str) -> Lock:
    if uid not in _user_locks: _user_locks[uid] = Lock()
    return _user_locks[uid]

def _ensure_users_csv():
    if not os.path.exists(USERS_CSV):
        with open(USERS_CSV, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=["user_id","username","password_hash","created_at"])
            w.writeheader()

def _load_user_by_username(username: str) -> Optional[dict]:
    if not os.path.exists(USERS_CSV): return None
    with open(USERS_CSV, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            if row.get("username") == username:
                return row
    return None

def _create_user(username: str, password: str) -> dict:
    _ensure_users_csv()
    if _load_user_by_username(username): 
        raise ValueError("username_taken")
    user_id = uuid.uuid4().hex
    pw_hash = bcrypt.hash(password)
    row = {"user_id": user_id, "username": username, "password_hash": pw_hash, "created_at": _now_iso()}
    rows = []
    if os.path.exists(USERS_CSV):
        with open(USERS_CSV, newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
    with open(USERS_CSV, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["user_id","username","password_hash","created_at"])
        w.writeheader()
        for r in rows: w.writerow(r)
        w.writerow(row)
    os.makedirs(os.path.join(DATA_DIR, "users", user_id), exist_ok=True)
    return row

def _issue_token(user_id: str, username: str) -> str:
    exp = datetime.utcnow() + timedelta(days=AUTH_TTL_DAYS)
    return jwt.encode({"sub": user_id, "u": username, "exp": exp}, AUTH_SECRET, algorithm=AUTH_ALGO)

def _read_token_from_cookie(request: Request) -> Optional[str]:
    return request.cookies.get("session")

def _get_current_user(request: Request) -> dict:
    token = _read_token_from_cookie(request)
    if not token:
        raise HTTPException(status_code=401, detail="not_authenticated")
    try:
        payload = jwt.decode(token, AUTH_SECRET, algorithms=[AUTH_ALGO])
    except JWTError:
        raise HTTPException(status_code=401, detail="invalid_token")
    return {"user_id": payload.get("sub"), "username": payload.get("u")}

def _user_dir(user_id: str) -> str:
    p = os.path.join(DATA_DIR, "users", user_id)
    os.makedirs(p, exist_ok=True)
    return p

def _fav_csv_path(uid: str) -> str:
    return os.path.join(_user_dir(uid), "favorites.csv")

def _courses_json_path(uid: str) -> str:
    return os.path.join(_user_dir(uid), "courses.json")

def _read_favorites(uid: str) -> list[dict]:
    p = _fav_csv_path(uid)
    if not os.path.exists(p): return []
    with open(p, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))

def _write_favorites(uid: str, rows: list[dict]):
    p = _fav_csv_path(uid)
    with open(p, "w", newline="", encoding="utf-8") as f:
        fields = ["id","title","addr","lat","lng","created_at"]
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k,"") for k in fields})

def _read_courses(uid: str) -> list[dict]:
    p = _courses_json_path(uid)
    if not os.path.exists(p): return []
    try:
        return json.load(open(p, encoding="utf-8"))
    except Exception:
        return []

def _write_courses(uid: str, items: list[dict]):
    p = _courses_json_path(uid)
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, ensure_ascii=False, indent=2)
    os.replace(tmp, p)


# =============================================================================
# 메타 캐시 & 나무위키 크롤러
# =============================================================================
def _meta_path(title: str, kind: Optional[str]) -> str:
    key = hashlib.sha1(f"{norm_title(title)}|{(kind or '').lower()}".encode("utf-8")).hexdigest()
    return os.path.join(CACHE_DIR, f"meta_{key}.json")

def _load_meta(title: str, kind: Optional[str]) -> Optional[dict]:
    p = _meta_path(title, kind)
    if not os.path.exists(p):
        return None
    try:
        mtime = datetime.utcfromtimestamp(os.path.getmtime(p))
        if datetime.utcnow() - mtime > timedelta(days=META_TTL_DAYS):
            return None
        with open(p, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None

def _save_meta(title: str, kind: Optional[str], data: dict) -> None:
    try:
        with open(_meta_path(title, kind), "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass

def _extract_poster_url(raw: dict) -> Optional[str]:
    u = None
    p = raw.get("poster")
    if isinstance(p, dict):
        u = p.get("url")
    elif isinstance(p, str):
        u = p
    if not u or u.startswith("data:"):
        return None
    if u.startswith("//"):
        u = "https:" + u
    return u

def _raw_to_meta(raw: dict, title_fallback: str, query_used: Optional[str]) -> dict:
    return {
        "title": raw.get("title_ko") or title_fallback,
        "released": (raw.get("air_dates") or {}).get("start"),
        "poster": _extract_poster_url(raw),
        "cast": raw.get("cast", []),
        "_source": raw.get("_source"),
        "_query_used": query_used,
    }

def _fetch_meta_try_suffixes(user_title: str, suffixes: list[str]) -> Optional[dict]:
    # 1) 원문+접미사들 2) 원문 그대로
    queries = [f"{user_title}{s}" for s in suffixes] + [user_title]

    # 1차: 포스터 있는 결과만
    for q in queries:
        try:
            raw = crawl_one(q, delay=0)   # ← 여기로 '오징어 게임 시즌1(드라마)' 같은 원문+접미사가 그대로 들어감
            meta = _raw_to_meta(raw, user_title, q)
            if meta.get("poster"):
                return meta
        except Exception:
            pass

    # 2차: 포스터 없어도 첫 성공
    for q in queries:
        try:
            raw = crawl_one(q, delay=0)
            return _raw_to_meta(raw, user_title, q)
        except Exception:
            pass
    return None

def _fetch_meta_drama_suffix_then_plain(title):  # title == user_title
    return _fetch_meta_try_suffixes(title, ["(드라마)", "(한국 드라마)", " (시즌3)"])

def _fetch_meta_film_suffix_then_plain(title):   # title == user_title
    return _fetch_meta_try_suffixes(title, ["(영화)", "(한국 영화)"])

def _fetch_meta(title: str, kind: Optional[str]) -> dict:
    kind_l = (kind or "").lower()
    meta = None
    if kind_l == "drama":
        meta = _fetch_meta_drama_suffix_then_plain(title)
    elif kind_l == "film":
        meta = _fetch_meta_film_suffix_then_plain(title)
    else:
        try:
            raw = crawl_one(title, delay=0)
            meta = _raw_to_meta(raw, title, title)
        except Exception:
            meta = None

    if meta:
        _save_meta(title, kind, meta)
        return meta
    return {
        "title": title,
        "released": None,
        "poster": None,
        "cast": [],
        "_source": None,
        "_query_used": None,
    }

def get_drama_meta(title: str, kind: Optional[str]) -> dict:
    return _load_meta(title, kind) or _fetch_meta(title, kind)

# =============================================================================
# FastAPI 앱
# =============================================================================
class ChatReq(BaseModel):
    mode: str
    keyword: Optional[str] = ""
    query: Optional[str] = ""
    kind: Optional[str] = None
    want_itinerary: Optional[bool] = False
    refresh: Optional[bool] = False
    lat: Optional[float] = None
    lng: Optional[float] = None
    radius_km: Optional[float] = None  # 추가: 반경 조절 (옵션)

    # (호환용 보조 플래그 — 프런트 구버전과의 호환을 위해 유지)
    update: Optional[bool] = False
    persist_cache: Optional[bool] = False
    use_cache_only: Optional[bool] = False
    no_cache_write: Optional[bool] = False

class GenReq(BaseModel):
    mode: str
    query: Optional[str] = None
    keyword: str
    kind: Optional[str] = None
    want_itinerary: Optional[bool] = False
    update: Optional[bool] = False
    persist_cache: Optional[bool] = False
    use_cache_only: Optional[bool] = False
    no_cache_write: Optional[bool] = False

# ====== Nearby spots by lat/lng (place mode) ======
def _iter_all_spots_from_gazetteer():
    """GAZ_IDX 전체를 평탄화해서 spot dict 리스트 반환"""
    ensure_gazetteer()
    rows = []
    for _, items in (GAZ_IDX or {}).items():
        for r in items:
            row = r.get("row", {}) if isinstance(r, dict) else {}
            lat = as_float(r.get("lat")); lng = as_float(r.get("lng"))
            if lat is None or lng is None:
                continue
            rows.append({
                "place_name": row.get("PLACE_NM") or row.get("place") or "",
                "address":     row.get("ADDR") or "",
                "lat": lat, "lng": lng,
                "media_type":  row.get("MEDIA_TY"),     # ex) 드라마/영화
                "place_type":  row.get("PLACE_TY"),
                "tel":         row.get("TEL_NO"),
                "work_title":  r.get("title"),          # 원본 CSV의 작품명(정규화 전)
            })
    return rows

# 상단 공용
from functools import lru_cache
import csv, math, os, sys

CSV_PATH = os.path.join(os.path.dirname(__file__), "drama_list.csv")

def haversine_km(lat1, lng1, lat2, lng2):
    R = 6371.0088
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = (math.sin(dlat/2)**2 +
         math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlng/2)**2)
    return 2 * R * math.asin(math.sqrt(a))

@lru_cache(maxsize=1)
def load_drama_list():
    rows = []
    if not os.path.exists(CSV_PATH):
        print(f"[place] CSV not found: {CSV_PATH}", file=sys.stderr)
        return rows

    with open(CSV_PATH, "r", encoding="utf-8-sig", newline="") as f:
        sniffer = csv.Sniffer()
        sample = f.read(4096)
        f.seek(0)
        dialect = sniffer.sniff(sample) if sample else csv.excel
        reader = csv.DictReader(f, dialect=dialect)

        for idx, r in enumerate(reader):
            # 컬럼 후보 폭넓게
            lat_raw = r.get("lat") or r.get("위도") or r.get("Latitude")
            lng_raw = r.get("lng") or r.get("경도") or r.get("Longitude")
            if lat_raw is None or lng_raw is None:
                continue
            try:
                lat = float(str(lat_raw).strip())
                lng = float(str(lng_raw).strip())
            except:
                continue

            title = (r.get("place") or r.get("장소명") or r.get("title") or "촬영지").strip()
            work  = (r.get("work")  or r.get("작품명")  or r.get("drama") or "").strip()
            addr  = (r.get("addr")  or r.get("주소")   or "").strip()
            pid   = (r.get("id")    or r.get("place_id") or f"csv_{idx}").strip()

            rows.append({
                "id": pid,
                "title": title,
                "work": work,
                "addr": addr,
                "lat": lat,
                "lng": lng,
            })

    print(f"[place] CSV loaded: {len(rows)} rows", file=sys.stderr)
    return rows


# === 공용: 임의 좌표 반경 내 촬영지 찾기 ===
def find_nearby_spots(lat: float, lng: float, radius_km: float = 1.0, max_items: int = 20):
    ensure_gazetteer()
    rows = []
    for _, items in (GAZ_IDX or {}).items():
        for r in items:
            row = r.get("row", {}) if isinstance(r, dict) else {}
            la, ln = as_float(r.get("lat")), as_float(r.get("lng"))
            if la is None or ln is None:
                continue
            rows.append({
                "place_name": row.get("PLACE_NM") or row.get("place") or "",
                "address":     row.get("ADDR") or "",
                "lat": la, "lng": ln,
                "media_type":  row.get("MEDIA_TY"),
                "place_type":  row.get("PLACE_TY"),
                "tel":         row.get("TEL_NO"),
                "work_title":  r.get("title"),
            })
    center = (lat, lng)
    out = []
    for i, s in enumerate(rows):
        d = _haversine_km(center, (s["lat"], s["lng"]))
        if d <= radius_km + 1e-9:
            meta = f'{s.get("work_title") or ""} · {s.get("media_type") or ""}'.strip(" ·")
            subtitle = " / ".join([t for t in [meta, s.get("address")] if t])
            out.append({
                "id": f"near_{i}",
                "type": "spot",
                "title": s["place_name"] or "(이름 없음)",
                "subtitle": subtitle,
                "lat": s["lat"], "lng": s["lng"],
                "dist_km": round(d, 2),
                "work_title": s.get("work_title"),
                "media_type": s.get("media_type"),
                "place_type": s.get("place_type"),
            })
        
    out.sort(key=lambda x: (x["dist_km"], x["title"]))
    return out[:max_items]



app = FastAPI(title="KTrip RAG Service", version="1.4")

# app.add_middleware(
#     CORSMiddleware,
#     allow_origins=[CORS_ALLOW_ORIG] if CORS_ALLOW_ORIG != "*" else ["*"],
#     allow_methods=["*"],
#     allow_headers=["*"],
# )

# ====== CORS (기존 미들웨어 교체) ======
app.add_middleware(
    CORSMiddleware,
    allow_origins=[CORS_ALLOW_ORIG] if CORS_ALLOW_ORIG != "*" else ["http://localhost:4000","http://127.0.0.1:4000","https://app.magiclab.kr","https://rag.magiclab.kr",],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ====== 인증 API ======
class AuthReq(BaseModel):
    username: str
    password: str

@app.post("/api/chatbot")
def api_chatbot(req: BotReq):
    """
    지도/사이드패널 컨텍스트 + 사용자의 질문을 기반으로
    OpenAI에게 답변 받아오는 간단 Q&A 챗봇.
    프론트: fetch('/api/chatbot', {question, context})
    응답: { ok: True, answer: "..." }
    """

    if not OPENAI_API_KEY:
        raise HTTPException(status_code=500, detail="OPENAI_API_KEY not set")

    # 컨텍스트 정리 (없을 수도 있으니까 안전하게 .get)
    ctx = req.context or BotContext()

    # system 역할: 이 AI가 어떤 역할로 말해야 하는지 고정
    system_prompt = (
        "너는 한국 사극/역사 드라마 촬영지 해설사(도슨트) AI야. "
        "사용자가 보고 있는 장소와 장면에 대해 역사적 배경, 드라마 속 상황, "
        "현실과의 차이점, 방문 팁 등을 한국어로 친절하고 짧게 설명해줘. "
        "너무 장황하게 떠들지 말고, 위험하거나 사유지 접근 금지 같은 건 확실하게 말해줘."
    )

    # user 메시지에 현재 장소 정보 + 실제 질문을 묶어서 전달
    user_msg = f"""
[현재 선택된 장소/장면 정보]
- 드라마 제목: {ctx.title or ""}
- 연도/장소표시: {ctx.year_place or ""}
- 장소명: {ctx.place or ""}
- 주소: {ctx.addr or ""}
- 주요 인물: {ctx.name or ""}
- 설명: {ctx.exp or ""}
- 출처: {ctx.ref or ""}

[사용자 질문]
{req.question}
    """.strip()

    # OpenAI 호출 (Responses / Chat Completions 스타일 중 하나 쓰면 됨)
    # 너랑 기존 번역기 코드에서 client.responses.create(...) 이미 쓰고 있지?
    # 그 패턴 그대로 가는 게 제일 편해.
    completion = client.responses.create(
        model="gpt-4o-mini",   # 가볍고 빠른 대화형 모델. gpt-4o 계열은 Q&A/어시스턴트 용도로 설계돼있어. 
        temperature=0.7,
        max_output_tokens=800,
        input=[
            {"role": "system", "content": system_prompt},
            {"role": "user",   "content": user_msg}
        ],
    )

    # output_text 는 OpenAI Python SDK (2024 이후 버전)에서 responses.create 결과를 간단히 뽑을 때 편하게 쓰라고 제공되는 필드야.
    answer_text = (getattr(completion, "output_text", None) or "").strip()

    # 혹시 비었으면 방어적으로 fallback
    if not answer_text:
        # choices[0].message.content 식 백업
        try:
            answer_text = completion.output[0].content[0].text.strip()
        except Exception:
            answer_text = "지금은 답변을 불러오지 못했어요. 잠시 후 다시 시도해 주세요."

    return {
        "ok": True,
        "answer": answer_text
    }


@app.get("/api/spots/nearby")
def api_spots_nearby(
    lat: float = Query(...),
    lng: float = Query(...),
    radius_km: float = Query(5.0, ge=0.2, le=50.0),
    max: int = Query(20, ge=1, le=300)
):
    items = find_nearby_spots(lat, lng, radius_km, max)
    return {"ok": True, "items": items}


@app.post("/api/auth/signup")
def auth_signup(req: AuthReq, response: Response):
    try:
        user = _create_user(req.username.strip(), req.password)
    except ValueError:
        return {"ok": False, "error": "username_taken"}
    token = _issue_token(user["user_id"], user["username"])
    response.set_cookie("session", token, httponly=True, samesite="Lax", secure=False, max_age=60*60*24*AUTH_TTL_DAYS, path="/")
    return {"ok": True, "user": {"user_id": user["user_id"], "username": user["username"]}}

@app.post("/api/auth/login")
def auth_login(req: AuthReq, response: Response):
    u = _load_user_by_username(req.username.strip())
    if not u or not bcrypt.verify(req.password, u["password_hash"]):
        return {"ok": False, "error": "bad_credentials"}
    token = _issue_token(u["user_id"], u["username"])
    response.set_cookie("session", token, httponly=True, samesite="Lax", secure=False, max_age=60*60*24*AUTH_TTL_DAYS, path="/")
    return {"ok": True, "user": {"user_id": u["user_id"], "username": u["username"]}}

@app.post("/api/auth/logout")
def auth_logout(response: Response):
    response.delete_cookie("session", path="/")
    return {"ok": True}

@app.get("/api/auth/me")
def auth_me(user=Depends(_get_current_user)):
    return {"ok": True, "user": user}

# ====== 즐겨찾기 API ======
@app.get("/api/user/favorites")
def list_favs(user=Depends(_get_current_user)):
    with _lock_for(user["user_id"]):
        return {"ok": True, "items": _read_favorites(user["user_id"])}

class FavItem(BaseModel):
    id: str
    title: str
    addr: Optional[str] = ""
    lat: float
    lng: float

@app.post("/api/user/favorites")
def add_fav(item: FavItem, user=Depends(_get_current_user)):
    with _lock_for(user["user_id"]):
        rows = _read_favorites(user["user_id"])
        if any(r.get("id")==item.id for r in rows):
            return {"ok": True, "dup": True}
        rows.append({
            "id": item.id, "title": item.title, "addr": item.addr or "",
            "lat": str(item.lat), "lng": str(item.lng), "created_at": _now_iso()
        })
        _write_favorites(user["user_id"], rows)
    return {"ok": True}

@app.delete("/api/user/favorites/{fid}")
def del_fav(fid: str = Path(...), user=Depends(_get_current_user)):
    with _lock_for(user["user_id"]):
        rows = [r for r in _read_favorites(user["user_id"]) if r.get("id") != fid]
        _write_favorites(user["user_id"], rows)
    return {"ok": True}

@app.post("/api/translate")
def api_translate(req: TranslateReq):
    if not OPENAI_API_KEY:
        raise HTTPException(500, "OPENAI_API_KEY not set on server")
    to = (req.to or "").lower()
    if to not in _LANG_MAP:
        raise HTTPException(400, "Unsupported target: en|jp|ch")
    if not req.texts:
        return {"ok": True, "lang": to, "translations": []}
    out = translate_bulk_with_cache(req.texts, to)
    return {"ok": True, "lang": to, "translations": out}

# ====== 내 코스 API ======
class CourseUpsert(BaseModel):
    id: Optional[str] = None
    title: str
    notes: Optional[str] = ""
    spots: List[Dict[str, Any]]  # [{id,title,subtitle,lat,lng}, ...]

@app.get("/api/user/courses")
def list_courses(user=Depends(_get_current_user)):
    with _lock_for(user["user_id"]):
        return {"ok": True, "items": _read_courses(user["user_id"])}

@app.get("/api/user/courses/{cid}")
def get_course(cid: str, user=Depends(_get_current_user)):
    with _lock_for(user["user_id"]):
        courses = _read_courses(user["user_id"])
        for c in courses:
            if c.get("id")==cid:
                return {"ok": True, "item": c}
    return {"ok": False, "error": "not_found"}

@app.post("/api/user/courses")
def upsert_course(payload: CourseUpsert, user=Depends(_get_current_user)):
    with _lock_for(user["user_id"]):
        courses = _read_courses(user["user_id"])
        if payload.id:
            # update
            for c in courses:
                if c.get("id")==payload.id:
                    c["title"] = payload.title
                    c["notes"] = payload.notes or ""
                    c["spots"] = payload.spots or []
                    c["updated_at"] = _now_iso()
                    _write_courses(user["user_id"], courses)
                    return {"ok": True, "id": c["id"]}
            return {"ok": False, "error": "not_found"}
        else:
            cid = uuid.uuid4().hex
            courses.append({
                "id": cid,
                "title": payload.title,
                "notes": payload.notes or "",
                "spots": payload.spots or [],
                "created_at": _now_iso(),
                "updated_at": _now_iso(),
            })
            _write_courses(user["user_id"], courses)
            return {"ok": True, "id": cid}

@app.delete("/api/user/courses/{cid}")
def del_course(cid: str, user=Depends(_get_current_user)):
    with _lock_for(user["user_id"]):
        courses = [c for c in _read_courses(user["user_id"]) if c.get("id")!=cid]
        _write_courses(user["user_id"], courses)
    return {"ok": True}

# tour API

@app.get("/api/tour/nearby")
def api_tour_nearby(
    lat: float = Query(..., description="위도"),
    lng: float = Query(..., description="경도"),
    radius: int = Query(2000, ge=100, le=50000),
    type: str = Query("all", description="'all' | 12 | 32 | 39"),
    max: int = Query(24, ge=1, le=100)
):
    """
    한국관광공사 TourAPI(서버측 프록시 + CSV 캐시)
    - ok: True|False
    - items: [{title,addr,lat,lng,cid,ctype,thumb,dist_km}]
    - cached: True/False
    - stale: True/False (API 실패 시 오래된 캐시라도 제공)
    """
    if not TOURAPI_KEY:
        return {"ok": False, "error": "tourapi_key_missing"}

    _ensure_tour_cache_file()
    key = f"{round(lat,5)}|{round(lng,5)}|{int(radius)}|{(type or 'all').lower()}"

    with _tour_cache_lock:
        cached = _tour_cache_read(key)

    if cached and _is_fresh(cached.get("updated_at", ""), TOURAPI_TTL_DAYS):
        return {"ok": True, "cached": True, "stale": False, "items": cached["items"][:max]}

    type_ids = _tour_type_ids(type)
    try:
        merged = {}
        for tid in type_ids:
            items = _tour_location_based(lat, lng, radius, tid, max)
            for it in items:
                cid = it.get("cid") or f"{it.get('lat')},{it.get('lng')},{tid}"
                if cid not in merged:
                    merged[cid] = it
        out = list(merged.values())
        out.sort(key=lambda x: (x.get("dist_km") if x.get("dist_km") is not None else 9e9, x.get("title") or ""))

        with _tour_cache_lock:
            _tour_cache_write(key, out)
        return {"ok": True, "cached": False, "stale": False, "items": out[:max]}
    except Exception as e:
        if cached:
            return {"ok": True, "cached": True, "stale": True, "items": cached["items"][:max], "warn": str(e)}
        return {"ok": False, "error": str(e)}

@app.get("/healthz")
def healthz():
    return {"ok": True, "csv_loaded": bool(GAZ_IDX)}


@app.get("/api/actor")
def api_actor(name: str = Query(..., description="배우 이름")):
    works = get_filmography(name)
    items, seen = [], set()
    for w in works:
        if w.kind not in ("tv", "film"):
            continue
        key = (w.title, w.year or 0, w.kind)
        if key in seen:
            continue
        seen.add(key)
        items.append({
            "kind": w.kind,
            "title": w.title,
            "year": w.year,
            "role": w.role,
            "network": w.network,
        })
    return {"ok": True, "items": items}

@app.get("/api/dramaMeta")
def api_drama_meta(
    title: str = Query(..., min_length=1, description="작품명"),
    kind: Optional[str] = Query(None, description="drama | film")
):
    try:
        meta = get_drama_meta(title, kind)
        return {"ok": True, **meta}
    except Exception as e:
        return {"ok": False, "error": str(e), "title": title, "kind": kind}

@app.on_event("startup")
def _startup():
    ensure_gazetteer()
    _ensure_yt_cache_file()
    _ensure_tour_cache_file()

@app.get("/api/youtube")
def api_youtube(q: str = Query(..., min_length=1), max: int = Query(4, ge=1, le=15)):
    """
    YouTube API 결과를 7일 CSV 캐시에 저장/재사용.
    - ok: True|False
    - items: [{id,title,channel,publishedAt,thumb}]
    - cached: True/False
    - stale: True/False (API 실패 시 오래된 캐시라도 내보낸 경우)
    """
    _ensure_yt_cache_file()

    q_norm = q.strip()
    with _yt_cache_lock:
        cached = _read_yt_cache(q_norm)

    if cached and _is_fresh(cached.get("updated_at", ""), YT_CACHE_TTL_DAYS):
        return {"ok": True, "cached": True, "stale": False, "items": cached["items"][:max], "q": q_norm}

    try:
        items = _yt_search_api(q_norm, max_results=max)
        with _yt_cache_lock:
            _write_yt_cache(q_norm, items)
        return {"ok": True, "cached": False, "stale": False, "items": items[:max], "q": q_norm}
    except Exception as e:
        if cached:
            return {"ok": True, "cached": True, "stale": True, "items": cached["items"][:max], "q": q_norm, "warn": str(e)}
        return {"ok": False, "error": str(e), "q": q_norm}


GOOGLE_API_KEY = os.environ.get("GOOGLE_API_KEY", "").strip()
GOOGLE_CX_ID   = os.environ.get("GOOGLE_CX_ID", "").strip()
import httpx
@app.get("/api/gcs")
async def gcs_proxy(
    q: str = Query(""),
    num: int = Query(10, ge=1, le=10),
    start: int = Query(1, ge=1),
    lr: str = Query("lang_ko"),
    safe: str = Query("active"),
):
    url = "https://www.googleapis.com/customsearch/v1"
    params = {
        "key": GOOGLE_API_KEY,
        "cx": GOOGLE_CX_ID,
        "q": q,
        "num": num,
        "start": start,
        "lr": lr,
        "safe": safe,
        "fields": "items(title,link,snippet,pagemap)",
    }
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            res = await client.get(url, params=params)
        if res.status_code != 200:
            return JSONResponse(
                {"ok": False, "error": f"google_cse_http_{res.status_code}", "detail": res.text[:200]},
                status_code=502,
            )
        data = res.json()
        return {"ok": True, "items": data.get("items", [])}
    except Exception as e:
        return JSONResponse({"ok": False, "error": "google_cse_proxy_fail", "detail": str(e)}, status_code=502)

@app.post("/api/chat")
def api_chat(req: ChatReq):
    """
    - mode == "work": 작품 검색 (핀 + 메타 + 추천 코스)
    - mode == "actor": 프런트는 /api/actor 사용 권장(여긴 안전 응답)
    """
    print(req.mode)
    if req.mode == "actor":
        return {"ok": True, "pins": [], "clusters": [], "pins_empty": True, "meta": None, "courses": []}
        
    elif req.mode == "place" or req.kind == "place":
        if req.lat is None or req.lng is None:
            raise HTTPException(status_code=400, detail="lat/lng required for place mode")

        lat0, lng0 = float(req.lat), float(req.lng)
        radius = float(req.radius_km or 5.0)

        rows = load_drama_list()
        print(f"[place] q=({lat0:.6f},{lng0:.6f}), radius={radius}km, total={len(rows)}", file=sys.stderr)

        # CSV가 비어있으면 즉시 빈 결과 반환
        if not rows:
            return {"ok": True, "mode": "place", "query": req.keyword or "",
                    "pins_empty": True, "pins": [], "courses": [], "meta": None}

        with_dist = []
        for r in rows:
            d = haversine_km(lat0, lng0, r["lat"], r["lng"])
            with_dist.append((d, r))
        with_dist.sort(key=lambda x: x[0])

        # 1차: 반경 안
        inside = [(d, r) for (d, r) in with_dist if d <= radius]
        print(f"[place] inside_count={len(inside)}", file=sys.stderr)

        # 2차: 반경 0건이면 가장 가까운 N건 fallback
        picked = inside if inside else with_dist[:20]

        nearest_pins = []
        for i, (dist, r) in enumerate(picked):
            # nearest_pins.append({
            #     # "id": r["id"] or f"near_{i}",
            #     # "title": r["title"],              # 장소명
            #     # "work": r.get("work") or "",      # ✅ 작품명 추가
            #     # "work_title": r.get("work") or "",# ✅ 호환용 키도 함께
            #     # "addr": r.get("addr") or "",      # (있다면) 주소도 별도 키로
            #     # "subtitle": " · ".join([v for v in [r["work"], r["addr"]] if v]),
            #     # "lat": r["lat"],
            #     # "lng": r["lng"],
            #     # "distance_km": round(dist, 3),
            #     "id": r["id"] or f"near_{i}",
            #     "title": r["title"],
            #     "subtitle": " · ".join([v for v in [r["work"], r["addr"]] if v]),
            #     "lat": r["lat"],
            #     "lng": r["lng"],
            #     "distance_km": round(dist, 3),
            #     # ✅ 추가: 그룹핑용 필드
            #     "work": r["work"],     # 또는 "work_title": r["work"]
            #     "addr": r["addr"],     # 주소도 분리 보관(선택)
            # })
            nearest_pins.append({
                "id": r["id"] or f"near_{i}",
                "title": r["title"],
                "subtitle": " · ".join([v for v in [r["work"], r["addr"]] if v]),
                "lat": r["lat"], "lng": r["lng"],
                "distance_km": round(dist, 3),
                "work": r["work"],         # ★ 그룹핑용
                "addr": r["addr"],         # (선택)
            })
        return {
            "ok": True,
            "mode": "place",
            "query": req.keyword or "",
            "pins_empty": len(nearest_pins) == 0,
            "pins": nearest_pins,
            "courses": [],
            "meta": None
        }

    title = (req.keyword or "").strip()
    if not title:
        return {"ok": False, "error": "keyword_required"}

    # ✅ 프런트 구버전 호환: refresh || update || persist_cache 가 하나라도 True면 갱신 요청으로 간주
    refresh_requested = bool(req.refresh or req.update or req.persist_cache)
    ensure_fresh_data(title, refresh_requested=refresh_requested)

    # 이후는 항상 CSV(가제티어) 기반 조회
    locs = search_locations_via_gazetteer(title)
    pins: List[Dict[str, Any]] = []
    for loc in locs:
        lat, lng = as_float(loc.get("lat")), as_float(loc.get("lng"))
        if lat is None or lng is None:
            continue
        pins.append({
            "id": f"pin_{len(pins)+1}",
            "type": "spot",
            "title": loc.get("place_name") or loc.get("title") or "",
            "subtitle": loc.get("address") or "",
            "lat": lat, "lng": lng
        })
    pins, _ = cluster_by_radius(pins, eps_km=60.0, min_samples=1)
    pins_empty = len(pins) == 0

    try:
        meta = get_drama_meta(title, req.kind)
    except Exception as e:
        print(f"[WARN] meta fetch failed for '{title}': {e}")
        meta = None

    courses = build_courses_from_pins(pins)
    return {
        "ok": True,
        "pins": pins,
        "clusters": [],
        "courses": courses,
        "pins_empty": pins_empty,
        "meta": meta,
        "ts": datetime.utcnow().isoformat() + "Z"
    }

@app.post("/generate")
def generate(req: GenReq):
    return api_chat(ChatReq(**req.dict()))

@app.get("/api/stream")
async def stream():
    q: asyncio.Queue = asyncio.Queue()
    SUBSCRIBERS.add(q)

    async def gen():
        try:
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=300)
                    yield "event: " + ev.get("type", "message") + "\n"
                    yield "data: " + json.dumps(ev, ensure_ascii=False) + "\n\n"
                except asyncio.TimeoutError:
                    yield "event: ping\n"
                    yield "data: {}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            SUBSCRIBERS.discard(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache"})

# =============================================================================
# CLI
# =============================================================================
def main():
    import argparse, uvicorn
    parser = argparse.ArgumentParser(description="KTrip RAG Service")
    parser.add_argument("--server", action="store_true")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=PORT)
    args = parser.parse_args()

    if args.server:
        print("[yt] key loaded:", bool(YOUTUBE_API_KEY), "suffix=" + (YOUTUBE_API_KEY[-6:] if YOUTUBE_API_KEY else "None"))
        uvicorn.run(app, host=args.host, port=args.port, reload=False)
        return

    sample = ChatReq(mode="work", keyword="오징어 게임 시즌 1", kind="drama")
    print(json.dumps(api_chat(sample), ensure_ascii=False, indent=2))

if __name__ == "__main__":
    main()
