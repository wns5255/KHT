# -*- coding: utf-8 -*-
import os
import re
import csv
import json
from datetime import datetime

JSON_FILE = "촬영지_with_coords.json"
CSV_FILE = "drama_list.csv"
OUTPUT_FILE = "drama_list.csv"  # 덮어쓰기 (append 모드 아님)

# ─────────────────────────────────────────────────────────────
# 작품명 정규화
#  - 공백/특수문자 제거
#  - 괄호 안 (드라마)/(영화) 등 제거
#  - "시즌N", "season N", "파트/part N", "N편/N부" 제거
#  - (기본) 맨 끝의 숫자만 단독으로 붙은 경우도 제거 → ‘오징어게임2’ == ‘오징어게임’
#    └ 환경변수 STRICT_TITLE_DEDUP=0 로 두면 “맨 끝 숫자 제거”는 하지 않음
# ─────────────────────────────────────────────────────────────
STRICT_TITLE_DEDUP = os.environ.get("STRICT_TITLE_DEDUP", "1")  # "1"=강하게 합치기(기본), "0"=완화

def _normalize_ws(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip()

def norm_title_key(title: str) -> str:
    s = _normalize_ws(title).lower()

    # 괄호 전체 제거 (예: (드라마), (영화), 기타 버전 표기)
    s = re.sub(r"[(){}\[\]<>〈〉《》「」『』【】]", "", s)

    # 시즌/파트/편 표기 제거
    # 시즌/season + 숫자
    s = re.sub(r"(시즌|season)\s*[0-9]+", "", s, flags=re.IGNORECASE)
    # 파트/part + 숫자
    s = re.sub(r"(파트|part)\s*[0-9]+", "", s, flags=re.IGNORECASE)
    # 숫자 + 편/부 (어미)
    s = re.sub(r"[0-9]+\s*(편|부)\b", "", s)

    # 구분자/특수문자/공백 제거
    s = re.sub(r"[\s·\.\-_:~]+", "", s)

    # (옵션) 맨 끝의 숫자를 제거해서 “오징어게임2”도 합치기
    if STRICT_TITLE_DEDUP == "1":
        s = re.sub(r"\d+$", "", s)

    # 최종 공백 제거
    s = s.strip()
    return s

def norm_place_key(s: str) -> str:
    # 장소/주소 비교시 공백만 정리
    return _normalize_ws(s)

def append_places_to_csv():
    # 기존 CSV 읽기
    try:
        with open(CSV_FILE, newline="", encoding="utf-8") as f:
            reader = list(csv.DictReader(f))
    except FileNotFoundError:
        reader = []

    # 마지막 SEQ_NO 찾기
    last_seq = 0
    for row in reversed(reader):
        try:
            last_seq = int(row["SEQ_NO"])
            break
        except (ValueError, KeyError):
            continue

    # 기존 데이터 중복 체크용 set (정규화된 title key 사용!)
    #  - key1: (media, title_key, place_name)
    #  - key2: (media, title_key, address)
    existing = set()
    for row in reader:
        media = (row.get("MEDIA_TY") or "").strip().lower()
        title_raw = row.get("TITLE_NM", "")
        title_key = norm_title_key(title_raw)

        place = norm_place_key(row.get("PLACE_NM", ""))
        addr = norm_place_key(row.get("ADDR", ""))

        if place:
            existing.add((media, title_key, place))
        if addr:
            existing.add((media, title_key, addr))

    # JSON 로드
    try:
        with open(JSON_FILE, encoding="utf-8") as f:
            places = json.load(f)
    except FileNotFoundError:
        print(f"[WARN] JSON 파일 {JSON_FILE} 없음 → 신규 추가 없음")
        places = []

    new_rows = []
    seq = last_seq

    for p in places:
        x, y = p.get("X"), p.get("Y")
        if not x or not y:
            continue  # 좌표 없는 건 건너뜀

        # media type: JSON에 MEDIA_TY가 있으면 그대로 사용, 없으면 drama
        media_ty = (p.get("MEDIA_TY") or "drama").strip().lower()

        title_nm = _normalize_ws(p.get("TITLE_NM", ""))
        place_nm = _normalize_ws(p.get("PLACE_NM", ""))
        addr = _normalize_ws(p.get("NORMALIZED_ADDRESS", ""))

        title_key = norm_title_key(title_nm)
        place_key = norm_place_key(place_nm)
        addr_key = norm_place_key(addr)

        # 중복 체크 (정규화된 title_key 기준)
        if (media_ty, title_key, place_key) in existing or (media_ty, title_key, addr_key) in existing:
            print(f"[SKIP] 중복 → {title_nm} - {place_nm} ({addr})")
            continue

        seq += 1
        new_rows.append({
            "SEQ_NO": seq,
            "MEDIA_TY": media_ty,
            "TITLE_NM": title_nm,
            "PLACE_NM": place_nm,
            "PLACE_TY": p.get("PLACE_TY", "etc"),
            "RELATE_PLACE_DC": p.get("RELATE_PLACE_DC", ""),
            "OPER_TIME": p.get("OPER_TIME", ""),
            "REST_TIME": p.get("REST_TIME", ""),
            "RSTDE_GUID_CN": p.get("RSTDE_GUID_CN", ""),
            "ADDR": addr,
            "LC_LA": y,  # 위도
            "LC_LO": x,  # 경도
            "TEL_NO": p.get("TEL_NO", ""),
            "LAST_UPDT_DE": datetime.now().strftime("%Y%m%d"),
        })

        # 방금 넣은 것도 existing에 즉시 반영(다음 항목 중복 방지)
        if place_key:
            existing.add((media_ty, title_key, place_key))
        if addr_key:
            existing.add((media_ty, title_key, addr_key))

    # 저장 (기존 + 신규)
    if not reader and not new_rows:
        print("[INFO] 기존 CSV도 없고 추가할 데이터도 없음 → 아무 작업 안함")
        return

    # 필드셋 정리(기존 헤더가 있으면 그대로, 없으면 신규의 키 사용)
    fieldnames = (reader[0].keys() if reader else new_rows[0].keys())

    with open(OUTPUT_FILE, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(reader)
        writer.writerows(new_rows)

    print(f"4단계: drama_list.csv에 {len(new_rows)}개 추가 완료")

if __name__ == "__main__":
    append_places_to_csv()
