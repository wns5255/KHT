import argparse
import requests
import csv
import os
import sys
import re

API_KEY = os.environ.get("GOOGLE_API_KEY", "").strip()
CX      = os.environ.get("GOOGLE_CX_ID", "").strip()
if not API_KEY or not CX:
    raise SystemExit("[ERROR] GOOGLE_API_KEY / GOOGLE_CX_ID 환경변수를 설정해주세요.")

LOG_FILE = "search_log.csv"

# ===== 콘솔 안전 출력 설정 (윈도우 cp949 대비) =====
def _configure_stdout():
    try:
        enc = getattr(sys.stdout, "encoding", None) or "utf-8"
        # 현재 콘솔 인코딩을 유지하되, 인코딩 불가 문자를 치환해서 절대 크래시 안 나게
        sys.stdout.reconfigure(encoding=enc, errors="replace")
        sys.stderr.reconfigure(encoding=enc, errors="replace")
    except Exception:
        pass

def safe(s: str) -> str:
    """현재 stdout 인코딩으로 안전하게 변환"""
    enc = (getattr(sys.stdout, "encoding", None) or "utf-8")
    return (str(s) if s is not None else "").encode(enc, errors="replace").decode(enc, errors="replace")

_configure_stdout()

# ===== 작품명 정규화 =====
def normalize(s: str) -> str:
    return re.sub(r"\s+", "", s or "").strip()

# ===== Google 검색 =====
def google_search_api(query: str, work_title: str, n: int = 10):
    url = "https://www.googleapis.com/customsearch/v1"
    params = {"key": API_KEY, "cx": CX, "q": query, "num": n}
    r = requests.get(url, params=params, timeout=10)
    r.raise_for_status()
    data = r.json()
    results = []

    must_keywords = ["촬영지", "촬영 장소", "촬영장소"]

    norm_title = normalize(work_title)

    for i, item in enumerate(data.get("items", []), 1):
        link = item.get("link")
        title = item.get("title") or ""
        if not link or "instagram.com" in link:
            continue

        # 🔹 필터 조건: 원래 제목 or 공백 제거한 제목 포함
        if work_title not in title and norm_title not in normalize(title):
            continue
        if not any(kw in title for kw in must_keywords):
            continue

        results.append({
            "rank": len(results) + 1,
            "title": title,
            "url": link,
            "snippet": item.get("snippet")
        })

        if len(results) >= n:
            break
    return results

# ===== 로그 저장 =====
def save_log(work_title, results):
    with open(LOG_FILE, "w", newline='', encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["work_title", "title", "url"])
        writer.writeheader()
        for r in results:
            writer.writerow({
                "work_title": work_title,
                "title": r["title"],
                "url": r["url"]
            })

# ===== 실행 엔트리 =====
def main():
    if len(sys.argv) < 2:
        print("Usage: python google.py <작품명>")
        sys.exit(1)

    work_title = " ".join(sys.argv[1:]).strip()  # 🔹 여러 단어 입력 허용
    query = f"{work_title} 한국 촬영지"

    print(f"1단계: 업데이트 시작: {safe(query)}")
    results = google_search_api(query, work_title, n=10)
    save_log(work_title, results)

    print(f"[INFO] search_log.csv 저장 완료 ({len(results)}건)")
    for r in results:
        # 유니코드 화살표 대신 ASCII 사용 + safe()로 콘솔 인코딩 방어
        print(f"[{r['rank']}] {safe(r['title'])} -> {r['url']}")

if __name__ == "__main__":
    main()
