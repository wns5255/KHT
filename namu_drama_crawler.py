
# -*- coding: utf-8 -*-
"""
namu_drama_crawler.py (poster-enabled)
-------------------------------------
Live crawler & parser for NamuWiki drama infobox tables, now with poster image support.

Usage examples:
  # Keyword
  python namu_drama_crawler.py --q "내 남편과 결혼해줘(드라마)" --out-json out.json --out-csv out.csv --save-images posters/

  # Explicit URL
  python namu_drama_crawler.py --url "https://namu.wiki/w/%EB%82%B4%20%EB%82%A8%ED%8E%B8%EA%B3%BC%20%EA%B2%B0%ED%98%BC%ED%95%B4%EC%A4%98(%EB%93%9C%EB%9D%BC%EB%A7%88)" --save-images posters/

  # Batch
  python namu_drama_crawler.py --qfile keywords.txt --suffix "(드라마)" --out-json batch.json --out-csv batch.csv --save-images posters/
"""
from __future__ import annotations

import re
import json
import time
import argparse
from typing import Dict, List, Optional, Any, Tuple
from urllib.parse import quote, urlparse
from pathlib import Path

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from bs4 import BeautifulSoup, Tag

# ----------------- Helpers -----------------

KO_LABELS = [
    "장르","방송 시간","방송 기간","방송 횟수",
    "기획","제작사","채널","제작진","원작","출연",
    "스트리밍","시청 등급","링크"
]

def normalize_ws(s: str) -> str:
    return re.sub(r"\\s+", " ", s or "").strip()

def parse_kor_date_to_iso(text: str) -> Optional[str]:
    text = normalize_ws(text)
    m = re.search(r"(?P<y>\\d{4})년\\s*(?P<m>\\d{1,2})월\\s*(?P<d>\\d{1,2})일", text)
    if m:
        y, m_, d = int(m.group("y")), int(m.group("m")), int(m.group("d"))
        return f"{y:04d}-{m_:02d}-{d:02d}"
    m = re.search(r"(?P<y>\\d{4})년", text)  # year only
    if m:
        y = int(m.group("y"))
        return f"{y:04d}-01-01"
    return None

def split_names(text: str) -> List[str]:
    parts = re.split(r"[,\u00B7·/]|,\\s*", text)
    return [normalize_ws(p) for p in parts if normalize_ws(p)]

def get_anchors_texts(cell: Tag) -> List[str]:
    return [normalize_ws(a.get_text()) for a in cell.find_all("a")]

def classify_link_name(href: str) -> str:
    try:
        host = urlparse(href).netloc.lower()
    except Exception:
        host = ""
    if "youtube.com" in host or "youtu.be" in host: return "YouTube"
    if "tvn.cjenm.com" in host: return "Homepage"
    if "tv.naver.com" in host: return "NaverTV"
    if "tv.kakao.com" in host: return "KakaoTV"
    if "instagram.com" in host: return "Instagram"
    if "facebook.com" in host: return "Facebook"
    if "x.com" in host or "twitter.com" in host: return "X"
    if "tving.com" in host: return "TVING"
    if "primevideo.com" in host: return "Prime Video"
    return host or href

def ensure_absolute_image_url(u: str) -> Optional[str]:
    if not u or u.startswith("data:"):
        return None
    if u.startswith("//"):
        return "https:" + u
    return u

def slugify(s: str, maxlen: int = 64) -> str:
    s = normalize_ws(s)
    s = re.sub(r"[^0-9A-Za-z가-힣._-]+", "_", s)
    return s[:maxlen].strip("_") or "poster"

# ----------------- Parser -----------------

class NamuDramaParser:
    def __init__(self, html: str):
        self.soup = BeautifulSoup(html, "lxml")
    
    def _pick_infobox_table(self) -> Optional[Tag]:
        tables = self.soup.find_all("table")
        best_tbl, best_score = None, -1
        for tbl in tables:
            text = normalize_ws(tbl.get_text(" "))
            score = sum(1 for k in KO_LABELS if k in text)
            if score > best_score:
                best_score, best_tbl = score, tbl
        return best_tbl
    
    def _parse_header_block(self, tbl: Tag, out: Dict[str, Any]) -> None:
        first_tr = tbl.find("tr")
        if not first_tr: return
        td = first_tr.find("td")
        if not td: return
        strings = [normalize_ws(s) for s in td.stripped_strings if normalize_ws(s)]
        links = td.find_all("a")
        if links:
            out["network"] = normalize_ws(links[0].get_text())
            if len(links) >= 2:
                out["slot"] = normalize_ws(links[1].get_text())
        strong = td.find("strong")
        if strong:
            out["title_ko"] = normalize_ws(strong.get_text())
        m = re.search(r"\\((\\d{4})\\)", " ".join(strings))
        if m:
            out["year"] = int(m.group(1))
        en = next((s for s in reversed(strings) if re.search(r"[A-Za-z]", s)), None)
        if en:
            out["title_en"] = en
    
    def _extract_poster(self, tbl: Tag) -> Optional[Dict[str, str]]:
        """
        Heuristic:
          1) Look at the row right after the header row; prefer <img> with domain i.namu.wiki
          2) Fallback to any image inside the table with i.namu.wiki and larger data-filesize
        """
        # Step 1: try second row
        first_tr = tbl.find("tr")
        second_tr = first_tr.find_next_sibling("tr") if first_tr else None
        candidates: List[Tuple[int, str, str]] = []  # (score, url, alt)
        def consider_img(img: Tag, bonus: int = 0):
            src = img.get("data-src") or img.get("src") or ""
            src = ensure_absolute_image_url(src)
            if not src or "i.namu.wiki" not in src:
                return
            # Skip icons / svgs
            if src.lower().endswith(".svg"):
                return
            size = 0
            try:
                size = int(img.get("data-filesize", "0"))
            except Exception:
                size = 0
            score = size + bonus
            alt = normalize_ws(img.get("alt") or "")
            candidates.append((score, src, alt))
        
        if second_tr:
            for img in second_tr.find_all("img"):
                # Big poster often has class like '_8AfUk5An' and width=100%
                bonus = 10_000 if img.get("class") else 0
                consider_img(img, bonus=bonus)
            if candidates:
                best = max(candidates, key=lambda x: x[0])
                return {"url": best[1], "alt": best[2]}
        
        # Step 2: scan all images in table
        for img in tbl.find_all("img"):
            consider_img(img, bonus=0)
        if candidates:
            best = max(candidates, key=lambda x: x[0])
            return {"url": best[1], "alt": best[2]}
        return None

    def _parse_label_value_rows(self, tbl: Tag, out: Dict[str, Any]) -> None:
        for tr in tbl.find_all("tr"):
            tds = tr.find_all("td")
            if not tds: continue
            label = None
            for i in range(min(2, len(tds))):
                st = tds[i].find("strong")
                if st:
                    label = normalize_ws(st.get_text())
                    break
            if not label: continue
            val_cell = tds[-1]
            if label == "장르":
                genres = get_anchors_texts(val_cell) or split_names(val_cell.get_text(" "))
                out["genre"] = genres
            elif label == "방송 시간":
                out["air_time"] = normalize_ws(val_cell.get_text(" "))
            elif label == "방송 기간":
                texts = [normalize_ws(x) for x in val_cell.stripped_strings]
                joined = " ".join(texts)
                parts = [normalize_ws(p) for p in re.split(r"[~\\-–to]+", joined) if normalize_ws(p)]
                start_iso = parse_kor_date_to_iso(parts[0]) if parts else None
                end_iso = parse_kor_date_to_iso(parts[1]) if len(parts) >= 2 else None
                out["air_dates"] = {"start": start_iso, "end": end_iso}
            elif label == "방송 횟수":
                m = re.search(r"(\\d+)", val_cell.get_text(" "))
                out["episodes"] = int(m.group(1)) if m else None
            elif label == "기획":
                out["planning"] = ", ".join(get_anchors_texts(val_cell) or split_names(val_cell.get_text(" ")))
            elif label == "제작사":
                studios = get_anchors_texts(val_cell) or split_names(val_cell.get_text(" "))
                out["studio"] = studios
            elif label == "채널":
                out["channel"] = ", ".join(get_anchors_texts(val_cell) or [normalize_ws(val_cell.get_text(" "))])
            elif label == "원작":
                out["original_work"] = normalize_ws(val_cell.get_text(" "))
            elif label == "출연":
                cast = [c for c in get_anchors_texts(val_cell) if c and c != "外"]
                out["cast"] = cast
            elif label == "스트리밍":
                regions = {}
                externals = [a["href"] for a in val_cell.find_all("a", href=True) if a["href"].startswith("http")]
                for href in externals:
                    name = classify_link_name(href)
                    regions.setdefault(name, {"service": name, "url": href})
                out["streaming"] = regions
            elif label == "시청 등급":
                rating_text = normalize_ws(val_cell.get_text(" "))
                m = re.search(r"(\\d+세\\s*이상\\s*시청가|전체\\s*관람가|[0-9]+세\\s*이상)", rating_text)
                out["rating"] = m.group(1) if m else rating_text
            elif label == "링크":
                uniq = {}
                for a in val_cell.find_all("a", href=True):
                    href = a["href"]
                    if href.startswith("http"):
                        uniq[href] = {"name": classify_link_name(href), "url": href}
                out["links"] = list(uniq.values())
            elif label == "제작진":
                inner_tbl = tr.find("table")
                staff = {}
                if inner_tbl:
                    for inner_tr in inner_tbl.find_all("tr"):
                        inner_tds = inner_tr.find_all("td")
                        if len(inner_tds) >= 2:
                            k = normalize_ws(inner_tds[0].get_text(" ")).replace(":", "")
                            v_anchors = get_anchors_texts(inner_tds[1])
                            v = v_anchors or split_names(inner_tds[1].get_text(" "))
                            staff[k] = v if len(v) != 1 else v[0]
                out["staff"] = staff
    
    def parse(self) -> Dict[str, Any]:
        out: Dict[str, Any] = {}
        tbl = self._pick_infobox_table()
        if not tbl:
            return out
        self._parse_header_block(tbl, out)
        # Poster extraction (before rows to avoid picking icon images later)
        poster = self._extract_poster(tbl)
        if poster:
            out["poster"] = poster
        self._parse_label_value_rows(tbl, out)
        return out

# ----------------- Fetcher -----------------

def build_namu_url(keyword: str) -> str:
    return f"https://namu.wiki/w/{quote(keyword)}"

def build_session() -> requests.Session:
    sess = requests.Session()
    retry = Retry(
        total=3,
        backoff_factor=1.0,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry)
    sess.mount("https://", adapter)
    sess.mount("http://", adapter)
    sess.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
    })
    return sess

def fetch_html(url_or_keyword: str, session: Optional[requests.Session] = None, timeout: int = 20) -> str:
    if url_or_keyword.startswith("http://") or url_or_keyword.startswith("https://"):
        url = url_or_keyword
    else:
        url = build_namu_url(url_or_keyword)
    session = session or build_session()
    resp = session.get(url, timeout=timeout)
    resp.raise_for_status()
    return resp.text

def parse_namu_drama_from_html(html: str) -> Dict[str, Any]:
    return NamuDramaParser(html).parse()

def download_poster(session: requests.Session, poster_url: str, title_hint: str, out_dir: Path) -> Optional[str]:
    try:
        out_dir.mkdir(parents=True, exist_ok=True)
        # pick extension
        ext = ".webp"
        for e in (".jpg",".jpeg",".png",".webp",".gif"):
            if poster_url.lower().split("?")[0].endswith(e):
                ext = e
                break
        fname = slugify(title_hint or "poster") + ext
        path = out_dir / fname
        r = session.get(poster_url, stream=True, timeout=30)
        r.raise_for_status()
        with open(path, "wb") as f:
            for chunk in r.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
        return str(path)
    except Exception:
        return None

def crawl_one(url_or_keyword: str, session: Optional[requests.Session] = None, delay: float = 1.0, save_images: Optional[Path] = None) -> Dict[str, Any]:
    session = session or build_session()
    html = fetch_html(url_or_keyword, session=session)
    data = parse_namu_drama_from_html(html)
    data["_source"] = url_or_keyword
    # Save poster if requested
    if save_images and isinstance(data.get("poster"), dict):
        title_hint = data.get("title_ko") or data.get("title_en") or "poster"
        poster_url = data["poster"].get("url")
        if poster_url:
            saved = download_poster(session, poster_url, title_hint, save_images)
            if saved:
                data["poster"]["file"] = saved
    time.sleep(delay)  # polite delay
    return data

# ----------------- CLI -----------------

def run_cli():
    import pandas as pd

    ap = argparse.ArgumentParser(description="NamuWiki drama infobox crawler (poster-enabled)")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--q", help="Keyword (e.g., '내 남편과 결혼해줘(드라마)')")
    g.add_argument("--url", help="Explicit URL to crawl")
    g.add_argument("--qfile", help="Text file with one keyword per line")
    ap.add_argument("--suffix", default="", help="Optional suffix to append to each keyword, e.g., '(드라마)'")
    ap.add_argument("--out-json", default=None, help="Write combined JSON list to this path")
    ap.add_argument("--out-csv", default=None, help="Write flattened CSV to this path")
    ap.add_argument("--delay", type=float, default=1.0, help="Delay seconds between requests (batch)")
    ap.add_argument("--save-images", default=None, help="Directory to store poster images")
    args = ap.parse_args()
    print(args.q)
    items: List[str] = []
    if args.q:
        items = [args.q]

    elif args.url:
        items = [args.url]
    elif args.qfile:
        p = Path(args.qfile)
        items = [line.strip() for line in p.read_text(encoding="utf-8").splitlines() if line.strip()]

    sess = build_session()
    results: List[Dict[str, Any]] = []
    img_dir = Path(args.save_images) if args.save_images else None

    for it in items:
        target = it if it.startswith("http") else (it + args.suffix if args.suffix and not it.endswith(args.suffix) else it)
        try:
            data = crawl_one(target, session=sess, delay=args.delay, save_images=img_dir)
        except Exception as e:
            data = {"_source": it, "_error": str(e)}
        results.append(data)

    # Save outputs
    if args.out_json:
        Path(args.out_json).write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

    if args.out_csv:
        rows = []
        for d in results:
            flat = {}
            for k, v in d.items():
                if isinstance(v, dict):
                    flat[k] = json.dumps(v, ensure_ascii=False)
                elif isinstance(v, list):
                    flat[k] = ", ".join(map(str, v))
                else:
                    flat[k] = v
            rows.append(flat)
        df = pd.DataFrame(rows)
        df.to_csv(args.out_csv, index=False, encoding="utf-8-sig")

    print(json.dumps(results, ensure_ascii=False, indent=2))

if __name__ == "__main__":
    run_cli()
