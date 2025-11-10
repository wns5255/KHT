# gemma3.py
import re
import csv
import json
import sys

from datetime import datetime
from urllib.parse import urlparse
from bs4 import BeautifulSoup
from playwright.sync_api import sync_playwright

from langchain_ollama import OllamaLLM
from langchain.schema import Document
from langchain.prompts import PromptTemplate

STOP_PHRASE = "주연 배우들의 또 다른 작품 촬영지"

# ===== 텍스트 정제 함수 =====
def clean_text(text: str) -> str:
    if not text:
        return ""
    text = re.sub(r'[\x00-\x1f\x7f-\x9f]', '', text)  # 제어문자 제거
    text = re.sub(r'\s+', ' ', text)  # 공백 정리
    return text.strip()

# ===== 작품명 추출 + 정규화 =====
def extract_work_title(query: str) -> str:
    m = re.search(r"'(.+?)'", query)
    return m.group(1).strip() if m else "default"

# ===== 공통: 페이지 HTML 가져오기 =====
def fetch_html(url: str, timeout=45000) -> str:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(url, timeout=timeout)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(1500)
        html = page.content()
        browser.close()
    return html

# ===== 네이버 블로그 본문 추출 =====
def extract_naver_blog_text(url, timeout=20000):
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(url, timeout=timeout)
        page.wait_for_load_state("networkidle")

        soup = BeautifulSoup(page.content(), "lxml")
        iframe = soup.select_one("iframe#mainFrame")
        if not iframe or not iframe.get("src"):
            browser.close()
            return ""

        iframe_url = f"https://blog.naver.com{iframe['src']}"
        page.goto(iframe_url, timeout=timeout)
        page.wait_for_load_state("networkidle")
        page.wait_for_timeout(2000)
        frame_html = page.content()
        browser.close()

    frame_soup = BeautifulSoup(frame_html, "lxml")
    selectors = [
        "div.se-main-container p",
        "div.se-component span",
        "div.se-module span",
        "div#postViewArea p",
        "div.se_textView p",
    ]
    for sel in selectors:
        elems = frame_soup.select(sel)
        if elems:
            return "\n".join(
                [clean_text(e.get_text(strip=True)) for e in elems if e.get_text(strip=True)]
            )
    return ""

# ===== 일반 티스토리 본문 추출 =====
def extract_tistory_text(url, timeout=60000):
    html = fetch_html(url, timeout=timeout)
    soup = BeautifulSoup(html, "lxml")
    selectors = [
        "div.entry-content p",
        "div.article p",
        "div.tt_article_useless_p_margin p",
    ]
    for sel in selectors:
        elems = soup.select(sel)
        if elems:
            text = "\n".join(
                [clean_text(e.get_text(strip=True)) for e in elems if e.get_text(strip=True)]
            )
            if STOP_PHRASE in text:
                text = text.split(STOP_PHRASE)[0]
            return text
    return ""

# ===== ys-dl 전용 파서 =====
def is_probable_place(name: str) -> bool:
    if not name:
        return False
    if len(name.strip()) < 2:
        return False
    bad_keywords = ["촬영지", "목차", "출처", "티스토리", "댓글", "지도"]
    if any(k in name for k in bad_keywords):
        return False
    return True

def extract_ysdl_places(url: str, timeout=45000):
    html = fetch_html(url, timeout=timeout)
    soup = BeautifulSoup(html, "lxml")

    content = soup.select_one("div.entry-content") or soup.select_one("div.article")
    if not content:
        print("[DEBUG] ys-dl 본문 컨테이너 못 찾음")
        return []

    nodes = list(content.find_all(["h2", "h3", "h4", "figcaption"], recursive=True))

    # 🔹 "목차"라는 단어가 나오는 지점 이후만 본문으로 간주
    start_idx = 0
    for i, n in enumerate(nodes):
        if "목차" in clean_text(n.get_text(" ", strip=True)):
            start_idx = i + 1
            break
    nodes = nodes[start_idx:]   # 목차 이후만 사용

    # STOP_PHRASE 기준으로 절단
    cut_idx = None
    for i, n in enumerate(nodes):
        if n.name in ("h2", "h3", "h4") and STOP_PHRASE in clean_text(n.get_text(" ", strip=True)):
            cut_idx = i
            break
    if cut_idx is not None:
        nodes = nodes[:cut_idx]

    places = []
    for n in nodes:
        if n.name in ("h2", "h3", "h4"):
            title = clean_text(n.get_text(" ", strip=True))
            if is_probable_place(title):
                places.append({"name": title, "address": None})
        elif n.name == "figcaption":
            addr = clean_text(n.get_text(" ", strip=True))
            if places and addr and not places[-1]["address"]:
                places[-1]["address"] = addr

    out = [clean_text(p["name"]) for p in places if is_probable_place(p["name"])]
    seen, dedup = set(), []
    for x in out:
        if x not in seen:
            seen.add(x)
            dedup.append(x)

    return dedup


# ===== search_log.csv 로딩 =====
def load_docs_from_search_log(csv_path, work_title):
    docs, ysdl_rows = [], []
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        count = 0   # 🔹 추가
        for row in reader:
            if row.get("work_title") and row["work_title"].strip() != work_title.strip():
                continue

            url = row["url"]
            domain = urlparse(url).netloc.lower()

            try:
                if domain.endswith("ys-dl.tistory.com"):
                    places = extract_ysdl_places(url)
                    for place in places:
                        ysdl_rows.append({
                            "TITLE_NM": work_title,
                            "PLACE_NM": clean_text(place),
                            "SRC_URL": [url],
                        })
                elif "blog.naver.com" in domain:
                    text = extract_naver_blog_text(url)
                    if text.strip():
                        docs.append(Document(page_content=text, metadata={"url": url, "title": row["title"], "work": work_title}))
                elif "tistory.com" in domain:
                    text = extract_tistory_text(url)
                    if text.strip():
                        docs.append(Document(page_content=text, metadata={"url": url, "title": row["title"], "work": work_title}))
            except Exception as e:
                print(f"[WARN] Failed to fetch {url}: {e}")

            count += 1
            if count >= 10:   # 🔹 최대 5개까지만
                break

    print(f"[INFO] Loaded {len(docs)} docs for {work_title} (ysdl_rows: {len(ysdl_rows)})")
    return docs, ysdl_rows


# ===== 장소명만 LLM으로 추출 =====
def analyze_and_extract_places(doc: Document, work_title):
    llm = OllamaLLM(model="gemma3")
    template = """
    아래 텍스트에서 드라마/영화 촬영지 **장소명만** JSON 배열로 추출하라.
    각 항목은 반드시 PLACE_NM 만 포함한다.
    출력은 JSON 배열만 하라.
    텍스트:
    {context}
    """
    prompt = PromptTemplate(template=template, input_variables=["context"])
    chain = prompt | llm

    context = doc.page_content[:10000]
    result_json = chain.invoke({"context": context})

    rows = []
    try:
        m = re.search(r"\[.*\]", result_json, re.S)
        if not m:
            return rows
        parsed = json.loads(m.group(0))
        for item in parsed:
            if isinstance(item, dict):
                place = clean_text(item.get("PLACE_NM", "").strip())
            elif isinstance(item, str):
                place = clean_text(item.strip())
            else:
                continue
            if place:
                rows.append({
                    "TITLE_NM": work_title,
                    "PLACE_NM": place,
                    "SRC_URL": [doc.metadata["url"]],
                })
    except Exception as e:
        print(f"[WARN] JSON 파싱 실패: {e}")
    return rows

# ===== JSON 저장 =====
def save_results_as_json(all_rows, output_json="촬영지_추출.json"):
    merged = {}
    for row in all_rows:
        key = (row["TITLE_NM"], clean_text(row["PLACE_NM"]))
        if key not in merged:
            merged[key] = {
                "TITLE_NM": row["TITLE_NM"],
                "PLACE_NM": clean_text(row["PLACE_NM"]),
                "SRC_URL": list(row.get("SRC_URL", [])),
            }
        else:
            if isinstance(row.get("SRC_URL"), list):
                merged[key]["SRC_URL"] = list(set(merged[key]["SRC_URL"] + row["SRC_URL"]))

    filtered = []
    for row in merged.values():
        if any("ys-dl.tistory.com" in src for src in row["SRC_URL"]):
            filtered.append(row)
        elif len(row["SRC_URL"]) >= 2:
            filtered.append(row)

    with open(output_json, "w", encoding="utf-8") as f:
        json.dump(filtered, f, ensure_ascii=False, indent=2)
    print(f"[INFO] Saved {len(filtered)} places to {output_json}")

# ===== 실행 메인 =====
def main():
    if len(sys.argv) < 2:
        print("Usage: python gemma3.py <작품명>")
        sys.exit(1)

    # 🔹 모든 argv[1:]을 합쳐서 작품명으로 처리
    work_title = " ".join(sys.argv[1:]).strip()
    print(f"2단계: 촬영지 추출 시작: {work_title}")

    docs, ysdl_rows = load_docs_from_search_log("search_log.csv", work_title)

    all_rows = []
    all_rows.extend(ysdl_rows)

    for doc in docs:
        rows = analyze_and_extract_places(doc, work_title)
        all_rows.extend(rows)

    save_results_as_json(all_rows, "촬영지_추출.json")


if __name__ == "__main__":
    main()
