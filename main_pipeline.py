# main_pipeline.py
import subprocess
import sys
import os

def cleanup_temp_files():
    keep_files = {"search_log.csv", "drama_list.csv"}
    delete_candidates = [
        "촬영지_추출.json",
        "geocode_results.json",
        "촬영지_with_coords.json"
    ]
    for f in delete_candidates:
        if os.path.exists(f) and f not in keep_files:
            try:
                os.remove(f)
                print(f"[CLEANUP] 삭제 완료: {f}")
            except Exception as e:
                print(f"[CLEANUP] 삭제 실패: {f} → {e}")

def run_step(script, desc, args=None):
    print(f"\n=== {desc} ({script}) ===")
    cmd = [sys.executable, script]
    if args:
        cmd.extend(args)
    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as e:
        print(f"[ERROR] {desc} 실행 실패: {e}")
        sys.exit(1)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("사용법: python main_pipeline.py <작품명>")
        sys.exit(1)

    work_title = sys.argv[1]

    # 1단계: 구글 검색 → search_log.csv 생성
    run_step("google.py", "1단계: 구글 검색", [work_title])

    # 2단계: 블로그 크롤링 + LLM 분석 → 촬영지_추출.json
    run_step("gemma3.py", "2단계: 촬영지 추출", [work_title])

    # 3단계: 카카오맵 API 좌표 변환 → 촬영지_with_coords.json
    run_step("kakao_geocode.py", "3단계: 좌표 변환", [work_title])

    # 4단계: CSV 병합 → drama_list.csv 갱신
    run_step("append_coords.py", "4단계: drama_list.csv 갱신", [work_title])

    print("전체 파이프라인 완료!")
    cleanup_temp_files()