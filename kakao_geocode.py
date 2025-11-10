# kakao_geocode.py
import os
import json
import time
import re
import requests
from typing import Dict, Any, Optional, Tuple
import sys

# ----- 설정 -----
INPUT_JSON  = "촬영지_추출.json"         # 이전 단계에서 만든 파일
OUTPUT_JSON = "촬영지_with_coords.json"  # 좌표 보강 결과 저장
RATE_LIMIT_SLEEP = 0.2                   # 호출 사이 딜레이(초)

KAKAO_REST_API_KEY = os.environ.get("KAKAO_REST_API_KEY", "").strip()
if not KAKAO_REST_API_KEY:
    raise SystemExit("[ERROR] 환경변수 KAKAO_REST_API_KEY가 없습니다.")

HEADERS = {"Authorization": f"KakaoAK {KAKAO_REST_API_KEY}"}
BASE = "https://dapi.kakao.com"


# ----- 유틸 -----
def norm(s: str) -> str:
    """공백/특수문자 제거해서 비교 용이하게 정규화"""
    if not s:
        return ""
    s = re.sub(r"\s+", "", s)
    s = re.sub(r"[^\w가-힣]", "", s)
    return s.lower()


def pick_best_keyword(documents: list, query: str) -> Optional[Dict[str, Any]]:
    """키워드 검색 결과 중 쿼리와 가장 잘 맞는 후보 선택"""
    if not documents:
        return None
    qn = norm(query)
    # 1) 장소명 완전 일치(공백/기호 무시)
    for d in documents:
        if norm(d.get("place_name", "")) == qn:
            return d
    # 2) 주소에 쿼리 일부 포함
    for d in documents:
        addr = f"{d.get('road_address_name','')}{d.get('address_name','')}"
        if qn and qn in norm(addr):
            return d
    # 3) 그냥 1순위
    return documents[0]


# ----- 카카오 API 호출 -----
def geocode_by_address(address: str) -> Optional[Tuple[str, str, str, Dict[str, Any]]]:
    """
    주소로 좌표 조회
    return: (x, y, normalized_address, raw_doc)
    """
    try:
        r = requests.get(
            f"{BASE}/v2/local/search/address.json",
            headers=HEADERS,
            params={"query": address, "page": 1, "size": 1},
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        docs = data.get("documents", [])
        if not docs:
            return None
        doc = docs[0]
        x = doc.get("x")
        y = doc.get("y")
        # 도로명 우선, 없으면 지번
        road = (doc.get("road_address") or {}).get("address_name")
        jibun = (doc.get("address") or {}).get("address_name")
        normalized = road or jibun or address
        if x and y:
            return x, y, normalized, doc
    except Exception as e:
        print(f"[WARN] geocode_by_address 실패: {address} -> {e}")
    return None


def geocode_by_keyword(query: str) -> Optional[Tuple[str, str, str, Dict[str, Any]]]:
    """
    키워드(장소명)로 좌표 조회
    return: (x, y, normalized_address, raw_doc)
    """
    try:
        r = requests.get(
            f"{BASE}/v2/local/search/keyword.json",
            headers=HEADERS,
            params={"query": query, "page": 1, "size": 5},  # 상위 5개에서 고르기
            timeout=10,
        )
        r.raise_for_status()
        data = r.json()
        docs = data.get("documents", [])
        best = pick_best_keyword(docs, query)
        if not best:
            return None
        x = best.get("x")
        y = best.get("y")
        addr = best.get("road_address_name") or best.get("address_name") or ""
        if x and y:
            return x, y, addr, best
    except Exception as e:
        print(f"[WARN] geocode_by_keyword 실패: {query} -> {e}")
    return None


# ----- 메인 로직 -----
def enrich_rows(rows: list) -> list:
    """
    각 row에 좌표 붙이기.
    row 스키마(필수): TITLE_NM, PLACE_NM, SRC_URL(list)
    row 스키마(선택): ADDRESS (있으면 주소 우선 geocode)
    """
    out = []
    cache: Dict[str, Dict[str, Any]] = {}  # 같은 쿼리 중복 방지

    for i, row in enumerate(rows, 1):
        title = row.get("TITLE_NM", "")
        place = row.get("PLACE_NM", "")
        address = row.get("ADDRESS")  # 선택 필드 (없으면 None)

        if not place:
            continue

        print(f"[{i}/{len(rows)}] {title} - {place}")

        # 캐시 키(주소 우선)
        q_key = f"A::{address}" if address else f"P::{place}"
        if q_key in cache:
            out.append({**row, **cache[q_key]})
            continue

        # 1) 주소가 있으면 주소로 먼저
        result = None
        if address:
            result = geocode_by_address(address)
            time.sleep(RATE_LIMIT_SLEEP)
            if result:
                x, y, naddr, raw = result
                geo = {
                    "X": x, "Y": y,
                    "NORMALIZED_ADDRESS": naddr,
                    "GEOCODE_SRC": "address",
                    "KAKAO_ID": raw.get("address_type", "")  # address API는 id가 없음
                }
                cache[q_key] = geo
                out.append({**row, **geo})
                continue
            # 주소 실패 시 키워드 폴백
            result = geocode_by_keyword(place)
            time.sleep(RATE_LIMIT_SLEEP)
            if result:
                x, y, naddr, raw = result
                geo = {
                    "X": x, "Y": y,
                    "NORMALIZED_ADDRESS": naddr,
                    "GEOCODE_SRC": "keyword_fallback",
                    "KAKAO_ID": raw.get("id")
                }
                cache[q_key] = geo
                out.append({**row, **geo})
                continue
        else:
            # 2) 주소가 없으면 키워드
            result = geocode_by_keyword(place)
            time.sleep(RATE_LIMIT_SLEEP)
            if result:
                x, y, naddr, raw = result
                geo = {
                    "X": x, "Y": y,
                    "NORMALIZED_ADDRESS": naddr,
                    "GEOCODE_SRC": "keyword",
                    "KAKAO_ID": raw.get("id")
                }
                cache[q_key] = geo
                out.append({**row, **geo})
                continue
            # 키워드 실패 시 주소 폴백(혹시 row에 다른 방식으로 들어온 ADDRESS가 있으면 시도)
            if address:
                result = geocode_by_address(address)
                time.sleep(RATE_LIMIT_SLEEP)
                if result:
                    x, y, naddr, raw = result
                    geo = {
                        "X": x, "Y": y,
                        "NORMALIZED_ADDRESS": naddr,
                        "GEOCODE_SRC": "address_fallback",
                        "KAKAO_ID": raw.get("address_type", "")
                    }
                    cache[q_key] = geo
                    out.append({**row, **geo})
                    continue

        # 여기까지 왔으면 좌표 실패
        cache[q_key] = {
            "X": None, "Y": None,
            "NORMALIZED_ADDRESS": None,
            "GEOCODE_SRC": "none",
            "KAKAO_ID": None
        }
        out.append({**row, **cache[q_key]})

    return out


def main():
    with open(INPUT_JSON, "r", encoding="utf-8") as f:
        rows = json.load(f)

    enriched = enrich_rows(rows)

    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(enriched, f, ensure_ascii=False, indent=2)

    done = sum(1 for r in enriched if r.get("X") and r.get("Y"))
    print(f"3단계: 좌표 성공 {done}/{len(enriched)} → {OUTPUT_JSON}")


if __name__ == "__main__":
    main()