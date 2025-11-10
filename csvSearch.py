import pandas as pd

def search_drama_locations_from_csv(drama_title):
    """
    drama_list.csv 파일에서 드라마 제목을 검색하여 촬영지 정보를 가져옵니다.
    """
    csv_path = 'drama_list.csv'
    try:
        df = pd.read_csv(csv_path)
        matching_rows = df[df['TITLE_NM'].str.contains(drama_title, case=False, na=False)]
        
        locations = []
        if not matching_rows.empty:
            for _, row in matching_rows.iterrows():
                location_info = {
                    '주소': row['ADDR'],
                    '위도': row['LC_LA'],
                    '경도': row['LC_LO']
                }
                locations.append(location_info)
        
        return locations
    
    except FileNotFoundError:
        print(f"오류: '{csv_path}' 파일을 찾을 수 없습니다.")
        return None
    except Exception as e:
        print(f"CSV 파일을 처리하는 중 오류가 발생했습니다: {e}")
        return None

# --- 함수 실행 및 결과 출력 ---
if __name__ == "__main__":
    # 테스트를 위한 검색 키워드
    test_keyword = "푸른 바다의 전설"
    
    # 함수를 호출하고 반환된 결과를 변수에 저장
    result = search_drama_locations_from_csv(test_keyword)
    
    # 결과가 존재하면 출력
    if result:
        print(f"'{test_keyword}'의 촬영지 정보:")
        for loc in result:
            print(f"  - 주소: {loc['주소']}, 위도: {loc['위도']}, 경도: {loc['경도']}")
    else:
        print(f"'{test_keyword}'에 대한 촬영지 정보를 찾을 수 없습니다.")