"""
KTrip — Filmography Console Tool (NamuWiki-only, RAG-ready, single-file)
- Strict: only tables inside <span id="드라마"> / <span id="영화"> sections
- Minimal deps: requests, beautifulsoup4  (cloudscraper optional)
- Output: normalized works list (tv/film, title, year, role, network)

Usage
-----
  pip install requests beautifulsoup4 cloudscraper  # cloudscraper is optional

  # 배우 이름만으로 필모그래피 파싱 (표준 출력)
  python actor_mode_crawler_and_aggregator.py --actor "한효주"

  # JSON 출력
  python actor_mode_crawler_and_aggregator.py -a "이병헌" --json

  # 가제티어(촬영지) 매칭까지 (컬럼명 예시: TITLE_NM, LC_LA, LC_LO)
  python actor_mode_crawler_and_aggregator.py -a "한효주" -g drama_list.csv --title-col TITLE_NM --lat-col LC_LA --lng-col LC_LO --json --debug

Import (for RAG)
----------------
  from actor_mode_crawler_and_aggregator import get_filmography, load_gazetteer, lookup_locations
  works = get_filmography("한효주")  # List[WorkEntry]
  gaz = load_gazetteer("drama_list.csv", title_col="TITLE_NM", lat_col="LC_LA", lng_col="LC_LO")
  for w in works: locs = lookup_locations(w.title, gaz)

Note
----
- Check target sites' terms and robots.txt before production use.
- The HTML structure can change; resilient heuristics + debug traces are included.
"""
from __future__ import annotations

import os
import re
import csv
import json
import difflib
import argparse
from dataclasses import dataclass, asdict
from typing import List, Dict, Optional, Tuple

import requests
from requests.adapters import HTTPAdapter
from urllib3.util import Retry
from bs4 import BeautifulSoup

# ------------------------------
# Debug toggle & helper
# ------------------------------
DEBUG = False

def dprint(*a, **kw):
    if DEBUG:
        print("[DBG]", *a, **kw)

def dbg(*a):
    if DEBUG:
        print("[DBG]", *a)

# ------------------------------
# Data Model
# ------------------------------
@dataclass
class WorkEntry:
    kind: str  # "tv" | "film"
    title: str
    year: Optional[int] = None
    role: Optional[str] = None
    network: Optional[str] = None
    raw: Optional[Dict] = None  # debugging

# ------------------------------
# HTTP session with retries
# ------------------------------
def _session(timeout: int = 10) -> requests.Session:
    s = requests.Session()
    retries = Retry(total=3, backoff_factor=0.4, status_forcelist=(429, 500, 502, 503, 504))
    s.mount("https://", HTTPAdapter(max_retries=retries))
    s.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
        ),
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.7",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    })
    orig = s.request
    def wrapped(method, url, **kwargs):
        kwargs.setdefault("timeout", timeout)
        return orig(method, url, **kwargs)
    s.request = wrapped  # type: ignore
    return s

# ------------------------------
# Regex / tokens
# ------------------------------
REF_RE = re.compile(r"\[\d+\]")
TITLE_BRACKET_RE = re.compile(r"[《》]")
NON_ALNUM_RE = re.compile(r"[^0-9A-Za-z가-힣]+", re.UNICODE)
RATING_RE = re.compile(r"\d+(?:\.\d+)?\s*%")
COUNT_RE  = re.compile(r"^[\d,]+\s*명$")
TOKEN_RE = re.compile(r"[가-힣A-Za-z0-9]+")

BAN_TOKENS = [
    "대한민국","국적","직업","배우","활동 기간","출생","제작발표회","촬영","에서",
    "거주지","본관","신체","가족","학력","종교","소속사","데뷔","MBTI","링크","FLaMme",
    "수상","수상 내역","MC","진행","홍보대사","광고","모델","라디오","예능","출연 프로그램","프로그램",
    "총 관객수","평균 관객수",
]

NETWORK_TOKENS = [
    "KBS", "KBS1", "KBS 1TV", "KBS2", "KBS 2TV",
    "MBC", "SBS", "tvN", "JTBC", "ENA", "OCN",
    "넷플릭스", "Netflix",
    "디즈니", "디즈니+", "Disney", "Disney+",
    "웨이브", "Wavve", "티빙", "TVING",
    "쿠팡", "쿠팡플레이", "Coupang", "Coupang Play",
    "카카오", "Kakao",
    "USA", "USA Network", "Lifetime"
]

PARENS_ANY_RE = re.compile(r"\s*\([^()]*\)\s*")

# ------------------------------
# Text helpers / heuristics
# ------------------------------
def _strip_refs(s: Optional[str]) -> Optional[str]:
    if not s: return s
    return REF_RE.sub("", s).strip()

def _t(x: str) -> str:
    x = re.sub(r"\s+", " ", (x or "").strip())
    x = _strip_refs(x) or ""
    return x

def _strip_all_parens(s: str) -> str:
    """Remove ALL (...) blocks (including multiple ones) and trim extra spaces."""
    prev = None
    while prev != s:
        prev = s
        s = PARENS_ANY_RE.sub(" ", s)
    return re.sub(r"\s+", " ", s).strip()

def _norm_title(s: Optional[str]) -> str:
    """Normalize title: remove any (...) meta, strip '/...' tails, tighten spaces."""
    if not s:
        return ""
    s = _t(s)
    # ① 모든 괄호 제거
    s = _strip_all_parens(s)
    # ② '/등장인물' 같은 꼬리 제거
    s = re.sub(r"/.*$", "", s)
    # ③ '독전 2' → '독전2'
    s = re.sub(r"([가-힣A-Za-z])\s+(\d)", r"\1\2", s)
    # ④ 콜론 공백 정리
    s = re.sub(r"\s*:\s*", ": ", s)
    return s.strip()

def _is_brand(s: str) -> bool:
    low = s.lower()
    return any(n.lower() in low for n in NETWORK_TOKENS)

def _is_rating(s: str) -> bool:
    return bool(RATING_RE.search(s or ""))

def _looks_noise(text: str) -> bool:
    if not text:
        return True
    t = text.strip()
    if len(t) <= 1:
        return True
    if _is_rating(t):               # 시청률
        return True
    if COUNT_RE.fullmatch(t):       # 관객 수 '123,456명'
        return True
    if re.fullmatch(r"\d{4}년.*", t):
        return True
    return any(tok in t for tok in BAN_TOKENS)

def _header_index(headers: List[str]) -> Dict[str, int]:
    cand = {
        "year":    ["연도", "방영연도", "방영 연도", "개봉", "년도", "Year"],
        "title":   ["제목", "작품명", "타이틀", "Title"],
        "role":    ["배역", "역할", "인물", "캐릭터", "Role"],
        "network": ["방송사", "채널", "OTT", "Network"],
        "activity":["출연", "활동", "구분", "비고"],  # 특별출연/카메오 등
    }
    idx = {k: -1 for k in cand}
    for i, h in enumerate(headers):
        for k, alts in cand.items():
            if any(a in h for a in alts):
                if k == "role" and idx[k] != -1:
                    continue
                idx[k] = i
    return idx

def _extract_year(text: Optional[str]) -> Optional[int]:
    if not text: return None
    m = re.search(r"(20\d{2}|19\d{2})", text)
    return int(m.group(1)) if m else None

def _first_anchor_text(row) -> Optional[str]:
    for td in row.find_all("td"):
        a = td.find("a")
        if a:
            return _t(a.get("title") or a.get_text(" "))
    return None

def _extract_brand_from_cell(td) -> Optional[str]:
    """셀 안의 모든 <a>를 훑어 브랜드 후보를 모으고, 가장 '방송 채널'스럽게 보이는 것을 선택."""
    if not td:
        return None
    cands = []
    for a in td.find_all("a"):
        cand = _t(a.get("title") or a.get_text(" "))
        cand = re.sub(r"\s*\[[0-9]+\]\s*", "", cand)
        cand = re.sub(r"\s*\(.*?\)\s*", "", cand).strip()
        if cand and _is_brand(cand) and cand not in cands:
            cands.append(cand)
    if not cands:
        raw = _t(td.get_text(" "))
        for tok in re.split(r"[\/·|,\s]+", raw):
            tok = tok.strip()
            if _is_brand(tok) and tok not in cands:
                cands.append(tok)
    if not cands:
        return None
    prefer = ["KBS2", "KBS 2TV", "KBS1", "KBS 1TV", "KBS", "MBC", "SBS", "tvN", "JTBC", "ENA", "OCN"]
    for p in reversed(prefer):
        for x in reversed(cands):
            if p.lower() == x.lower():
                return x
    return cands[-1]

def _rank_key(w: WorkEntry) -> Tuple[int, int]:
    # 연도 내림차순, 같은 연도면 TV 먼저
    return (w.year or 0, 1 if w.kind == "tv" else 0)

def _dedupe(items: List[WorkEntry]) -> List[WorkEntry]:
    out: List[WorkEntry] = []
    seen = set()
    for it in items:
        k = (it.kind, normalize_title_key(_norm_title(it.title)), it.year or 0)
        if k in seen:
            continue
        seen.add(k)
        out.append(it)
    return out

# ------------------------------
# Gazetteer: title → locations (lat/lng)
# ------------------------------
def normalize_title_key(s: Optional[str]) -> str:
    s = _strip_refs(s or "")
    s = TITLE_BRACKET_RE.sub("", s)
    s = s.strip().lower()
    s = NON_ALNUM_RE.sub("", s)
    return s

def _open_text(path: str):
    try:
        return open(path, encoding="utf-8")
    except UnicodeDecodeError:
        return open(path, encoding="cp949", errors="ignore")

def _guess_col(cols: list, candidates: list) -> Optional[str]:
    lc = {c.lower(): c for c in cols}
    for cand in candidates:
        if cand.lower() in lc:
            return lc[cand.lower()]
    if cols:
        match = difflib.get_close_matches(candidates[0].lower(), [c.lower() for c in cols], n=1, cutoff=0.6)
        if match:
            return lc[match[0]]
    return None

def load_gazetteer(path: str, title_col: Optional[str] = None, lat_col: Optional[str] = None, lng_col: Optional[str] = None) -> Dict[str, list]:
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    ext = os.path.splitext(path)[1].lower()
    records: list = []
    if ext in (".csv", ".tsv"):
        with _open_text(path) as f:
            sample = f.read(2048)
            f.seek(0)
            dialect = csv.Sniffer().sniff(sample) if ext == ".csv" else csv.excel_tab
            reader = csv.DictReader(f, dialect=dialect)
            cols = [c.strip() for c in (reader.fieldnames or [])]
            tcol = title_col or _guess_col(cols, ["TITLE_NM","title","작품명","work","작품","drama","드라마"])
            latc = lat_col or _guess_col(cols, ["LC_LA","lat","latitude","위도"])
            lngc = lng_col or _guess_col(cols, ["LC_LO","lng","long","lon","longitude","경도"])
            if not (tcol and latc and lngc):
                raise ValueError(f"Column mapping required. Found columns={cols}; need title/lat/lng.")
            dprint(f"[gazetteer] cols: title={tcol}, lat={latc}, lng={lngc}")
            for row in reader:
                try:
                    title = (row.get(tcol) or "").strip()
                    lat = float((row.get(latc) or "").strip())
                    lng = float((row.get(lngc) or "").strip())
                    rec = {"title": title, "lat": lat, "lng": lng, "row": row}
                    records.append(rec)
                except Exception:
                    continue
    elif ext in (".json", ".ndjson"):
        with _open_text(path) as f:
            data = json.load(f)
        if isinstance(data, dict):
            data = list(data.values())
        for row in data:
            if not isinstance(row, dict):
                continue
            title = (row.get(title_col or "TITLE_NM") or row.get("title") or row.get("작품명") or row.get("work") or row.get("작품") or "").strip()
            lat = row.get(lat_col or "LC_LA") or row.get("lat") or row.get("위도") or row.get("latitude")
            lng = row.get(lng_col or "LC_LO") or row.get("lng") or row.get("경도") or row.get("longitude")
            try:
                rec = {"title": title, "lat": float(lat), "lng": float(lng), "row": row}
                records.append(rec)
            except Exception:
                continue
    else:
        raise ValueError("Unsupported gazetteer format. Use CSV/TSV/JSON.")

    index: Dict[str, list] = {}
    for rec in records:
        key = normalize_title_key(rec["title"])
        if not key:
            continue
        index.setdefault(key, []).append(rec)
    dprint(f"[gazetteer] loaded records={len(records)}, keys={len(index)}")
    return index

def _tokens(s: str) -> List[str]:
    return [t for t in TOKEN_RE.findall(s or "") if t]

def _jaccard(a: List[str], b: List[str]) -> float:
    A, B = set(a), set(b)
    if not A or not B: return 0.0
    return len(A & B) / len(A | B)

def lookup_locations(title: str, index: Dict[str, list], fuzzy: bool = True, *, cutoff: float = 0.8) -> list:
    key = normalize_title_key(title)
    if key in index:
        dprint(f"[gazetteer] exact hit: '{title}' -> key='{key}' count={len(index[key])}")
        return index[key]
    if not fuzzy or not index:
        return []
    candidates = difflib.get_close_matches(key, list(index.keys()), n=3, cutoff=cutoff)
    dprint(f"[gazetteer] fuzzy for '{title}' key='{key}' -> cands={candidates}")
    if not candidates:
        return []
    q_tokens = _tokens(title)
    for cand in candidates:
        c_tokens = _tokens(cand)
        if _jaccard(q_tokens, c_tokens) < 0.6:
            continue
        if len("".join(c_tokens)) <= 2 and len(q_tokens) >= 2:
            continue
        return index.get(cand, [])
    return []

# ------------------------------
# Provider: NamuWiki (strict span id="드라마"/"영화")
# ------------------------------
class NamuWikiProvider:
    BASE = "https://namu.wiki/w/"
    SECT_TV   = ["드라마"]
    SECT_FILM = ["영화"]

    def __init__(self, session: Optional[requests.Session] = None):
        self.s = session or _session()

    def fetch_html(self, actor: str) -> Optional[str]:
        url = self.BASE + requests.utils.quote(actor)
        try:
            dbg("[namu] GET", url)
            r = self.s.get(url, allow_redirects=True)
            dbg("[namu] status=", r.status_code, "bytes=", len(r.text or ""))
            if r.status_code == 200 and r.text and ("Just a moment" not in r.text):
                return r.text
            # fallback: cloudscraper (optional)
            try:
                import cloudscraper
                dbg("[namu] cloudscraper try")
                scraper = cloudscraper.create_scraper(
                    browser={"browser": "chrome", "platform": "windows", "mobile": False}
                )
                r2 = scraper.get(url)
                dbg("[namu] cloudscraper status=", r2.status_code, "bytes=", len(r2.text or ""))
                if r2.status_code == 200 and r2.text:
                    return r2.text
            except Exception as e:
                dbg("[namu] cloudscraper skip:", str(e))
        except Exception as e:
            dbg("[namu] fetch_html err:", e)
        return None

    def get(self, actor: str) -> Dict[str, List[WorkEntry]]:
        html = self.fetch_html(actor)
        if not html:
            return {"tv": [], "film": []}
        soup = BeautifulSoup(html, "html.parser")
        tv   = self._parse_sections(soup, self.SECT_TV,   kind_override="tv")
        film = self._parse_sections(soup, self.SECT_FILM, kind_override="film")
        dbg("[namu] tv=", len(tv), "film=", len(film), "before dedupe")
        return {"tv": tv, "film": film}

    # --- helpers ---
    def _find_heads(self, soup: BeautifulSoup, labels: List[str]) -> List[BeautifulSoup]:
        heads = []
        for lbl in labels:
            for sp in soup.find_all("span", id=lbl):
                h = sp.find_parent(["h2", "h3"]) or sp
                heads.append(h)
        dbg("[namu] find_heads labels=", labels, "->", len(heads), "heads:", [ _t(h.get_text(' ')) for h in heads ])
        return heads

    def _iter_tables_in_section(self, head: BeautifulSoup):
        seen_start = False
        for el in head.next_elements:
            if el is head:
                continue
            if getattr(el, "name", None) in ("h2", "h3"):
                break
            if getattr(el, "name", None) == "table":
                yield el

    def _is_summary_table(self, table) -> bool:
        rows = table.find_all("tr")
        if not rows: return False
        head_text = " ".join(_t(th.get_text(" ")) for th in rows[0].find_all(["th","td"]))
        if not head_text: return False
        # 제목 헤더가 있어야 '작품 표'로 인정 (시청률/총관객수 요약 등 차단)
        if ("제목" in head_text or "작품명" in head_text or "Title" in head_text):
            if not any(k in head_text for k in ["총 관객수", "평균 관객수", "수상", "예능", "홍보대사"]):
                return True
        return False

    # --- 요약표 파서: rowspan 보정 + 특별출연 제외 + 네트워크/연도/배역 정리 ---
    def _parse_summary_table(self, table, kind_override: str) -> List[WorkEntry]:
        rows = table.find_all("tr")
        if not rows: return []

        headers = [_t(th.get_text(" ")) for th in rows[0].find_all(["th","td"])]
        idx = _header_index(headers)
        if idx["title"] == -1:
            dbg(f"[{kind_override}] skip table (no explicit title header): {headers}")
            return []

        ncols = len(headers)
        out: List[WorkEntry] = []
        carry_txt, carry_node, carry_left = [None]*ncols, [None]*ncols, [0]*ncols

        for row in rows[1:]:
            cells, nodes = [None]*ncols, [None]*ncols

            # 1) rowspan carry 적용
            for j in range(ncols):
                if carry_left[j] > 0:
                    cells[j] = carry_txt[j]
                    nodes[j] = carry_node[j]
                    carry_left[j] -= 1

            # 2) 이번 행 td 배치 (colspan/rowspan 반영)
            c = 0
            for td in row.find_all("td"):
                while c < ncols and cells[c] is not None:
                    c += 1
                if c >= ncols: break
                txt = _t(td.get_text(" ").replace("\n"," "))
                cs = int(td.get("colspan") or 1)
                rs = int(td.get("rowspan") or 1)
                for k in range(cs):
                    j = c + k
                    if j >= ncols: break
                    cells[j] = txt
                    nodes[j] = td
                    if rs > 1:
                        carry_txt[j], carry_node[j], carry_left[j] = txt, td, rs - 1
                c += cs

            line = " ".join(x for x in cells if x)

            # 3) 연도
            year = None
            if idx["year"] != -1 and cells[idx["year"]]:
                year = _extract_year(cells[idx["year"]])
            if not year:
                year = _extract_year(line)
            if not year:
                continue

            # 4) 활동/구분: 특별출연/카메오면 스킵
            if idx["activity"] != -1 and cells[idx["activity"]]:
                act = cells[idx["activity"]]
                if ("특별출연" in act) or ("카메오" in act):
                    continue

            # 5) 제목 (지정 칼럼 anchor 우선 → 행의 첫 anchor → 셀 텍스트)
            title = None
            if idx["title"] != -1 and nodes[idx["title"]]:
                a = nodes[idx["title"]].find("a")
                title = _t(a.get("title") or a.get_text(" ")) if a else None
            if not title:
                title = _first_anchor_text(row)
            if not title and idx["title"] != -1 and cells[idx["title"]]:
                title = cells[idx["title"]]
            title = _norm_title(title)
            if (not title) or _looks_noise(title) or _is_brand(title):
                continue

            # 6) 배역: 시청률/활동뱃지 같은 비역 텍스트 제거
            role = None
            if idx["role"] != -1:
                td_role = nodes[idx["role"]]
                role = _t(td_role.get_text(" ")) if td_role else (cells[idx["role"]] or None)
            if role and (_is_rating(role) or role in ("주연","조연","특별출연","카메오")):
                role = None

            # 7) 방송사/OTT
            network = None
            if idx["network"] != -1:
                td_net = nodes[idx["network"]]
                network = _extract_brand_from_cell(td_net) if td_net else None
                if (not network) and cells[idx["network"]]:
                    txt = cells[idx["network"]]
                    network = txt if _is_brand(txt) else None

            out.append(WorkEntry(kind=kind_override, title=title, year=year, role=role, network=network, raw={"cols": cells}))

        return _dedupe(out)

    def _parse_matrix_table(self, table, kind_override: str) -> List[WorkEntry]:
        out: List[WorkEntry] = []
        for td in table.find_all("td"):
            cell_txt = _t(td.get_text(" "))
            # 특별출연/카메오 셀 제외 (설명 칸에 이런 표기가 많음)
            if ("특별출연" in cell_txt) or ("카메오" in cell_txt):
                continue

            year = _extract_year(cell_txt)
            if not year:
                continue

            a = td.find("a")
            st = a.find("strong") if a else td.find("strong")
            title = _t(st.get_text(" ")) if st else (_t(a.get_text(" ")) if a else None)
            title = _norm_title(title)
            if not title or _looks_noise(title) or _is_brand(title):
                continue

            role = None
            if kind_override != "film":
                m_char = re.search(r"([가-힣A-Za-z0-9 ]+)\s*역", cell_txt)
                if m_char:
                    role = _t(m_char.group(1))

            out.append(WorkEntry(kind=kind_override, title=title, year=year, role=role))
        return _dedupe(out)

    # --- 섹션 파서: 요약표가 하나라도 나오면 매트릭스 표는 건너뜀 ---
    def _parse_sections(self, soup: BeautifulSoup, labels: List[str], kind_override: str) -> List[WorkEntry]:
        out: List[WorkEntry] = []
        heads = self._find_heads(soup, labels)
        dbg(f"[{kind_override}] heads={len(heads)}")
        for i, head in enumerate(heads, 1):
            dbg(f"[{kind_override}] head#{i} text={_t(head.get_text(' '))}")
            tables = list(self._iter_tables_in_section(head))
            has_summary = any(self._is_summary_table(t) for t in tables)
            if has_summary:
                for tbl in tables:
                    if self._is_summary_table(tbl):
                        got = self._parse_summary_table(tbl, kind_override)
                        dbg(f"[{kind_override}] summary_table rows +{len(got)}")
                        out.extend(got)
            else:
                for tbl in tables:
                    got = self._parse_matrix_table(tbl, kind_override)
                    if got:
                        dbg(f"[{kind_override}] matrix_table rows +{len(got)}")
                        out.extend(got)
        return _dedupe(out)

# ------------------------------
# Public API (import for RAG)
# ------------------------------
def get_filmography(actor: str) -> List[WorkEntry]:
    """Return deduped filmography entries (tv + film), recent first (NamuWiki only)."""
    sess = _session()
    data = NamuWikiProvider(sess).get(actor)
    works = _dedupe(data.get("tv", []) + data.get("film", []))
    works = [w for w in works if w.year]  # 연도 없는 항목 제외
    works.sort(key=_rank_key, reverse=True)
    dprint(f"[summary] tv={len(data.get('tv', []))}, film={len(data.get('film', []))}, merged={len(works)}")
    return works

# ------------------------------
# CLI
# ------------------------------
if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Filmography console tool (NamuWiki-only) + Gazetteer lookup")
    ap.add_argument("--actor", "-a", required=True, help="배우 이름")
    ap.add_argument("--limit", "-l", type=int, default=200, help="최대 개수")
    ap.add_argument("--json", action="store_true", help="JSON 출력")
    ap.add_argument("--gazetteer", "-g", help="drama_list 경로 (CSV/TSV/JSON)")
    ap.add_argument("--title-col", help="제목 컬럼명(예: TITLE_NM)")
    ap.add_argument("--lat-col", help="위도 컬럼명(예: LC_LA)")
    ap.add_argument("--lng-col", help="경도 컬럼명(예: LC_LO)")
    ap.add_argument("--debug", action="store_true", help="디버그 출력")
    args = ap.parse_args()

    # enable debug
    DEBUG = args.debug

    # Optional gazetteer load
    gaz_idx = None
    if args.gazetteer and os.path.exists(args.gazetteer):
        try:
            gaz_idx = load_gazetteer(args.gazetteer, title_col=args.title_col, lat_col=args.lat_col, lng_col=args.lng_col)
        except Exception as e:
            print(f"[WARN] Gazetteer load failed: {e}")
            gaz_idx = None

    def attach_locations(entry_list: List[WorkEntry]) -> List[dict]:
        out = []
        for w in entry_list:
            item = asdict(w)
            item["locations"] = []
            if gaz_idx:
                locs = lookup_locations(w.title, gaz_idx, fuzzy=True, cutoff=0.8)
                if locs:
                    item["locations"] = [{
                        "lat": r["lat"],
                        "lng": r["lng"],
                        "title_src": r["title"],
                        # optional metadata from your schema
                        "place_name": r["row"].get("PLACE_NM"),
                        "address": r["row"].get("ADDR"),
                        "media_type": r["row"].get("MEDIA_TY"),
                        "place_type": r["row"].get("PLACE_TY"),
                        "tel": r["row"].get("TEL_NO"),
                    } for r in locs]
            out.append(item)
        return out

    works = get_filmography(args.actor)
    works = works[: args.limit]

    if args.json:
        payload = attach_locations(works)
        if args.debug and gaz_idx:
            keys = list(gaz_idx.keys()) if gaz_idx else []
            for item in payload:
                nk = normalize_title_key(item["title"])
                cand = difflib.get_close_matches(nk, keys, n=1, cutoff=0.0)
                best = cand[0] if cand else "(none)"
                print(f"[DEBUG] title='{item['title']}' -> norm='{nk}' | best='{best}' | locs={len(item['locations'])}")
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(f"=== {args.actor} — works({len(works)}) ===")
        for w in works:
            y = w.year if w.year else "-"
            role = f" · {w.role}" if w.role else ""
            net = f" · {w.network}" if w.network else ""
            print(f"[{w.kind}] {y} · {w.title}{role}{net}")
            if gaz_idx:
                locs = lookup_locations(w.title, gaz_idx, fuzzy=True, cutoff=0.8)
                for i, r in enumerate(locs[:5], 1):
                    print(f"    #{i} → ({r['lat']}, {r['lng']}) · src: {r['title']} · {r['row'].get('PLACE_NM')} · {r['row'].get('ADDR')}")
