import requests
from bs4 import BeautifulSoup
import urllib.parse
import json

def crawl_and_save_wiki_sections_to_json(search_keyword):
    """
    위키백과 페이지의 섹션별 내용을 크롤링하여 JSON 파일로 저장합니다.
    
    :param search_keyword: 크롤링할 위키백과 페이지의 제목 (예: '푸른 바다의 전설').
    """
    encoded_keyword = urllib.parse.quote(search_keyword)
    base_url = "https://ko.wikipedia.org/wiki/"
    full_url = base_url + encoded_keyword
    
    print(f"크롤링을 시작합니다: {full_url}")
    
    try:
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/58.0.3029.110 Safari/537.3'}
        response = requests.get(full_url, headers=headers)
        response.raise_for_status()
        
        soup = BeautifulSoup(response.text, 'html.parser')
        
        page_data = {}
        
        # 'infobox' 테이블에서 주요 정보 추출
        infobox = soup.find('table', class_='infobox')
        if infobox:
            infobox_data = {}
            for row in infobox.find_all('tr'):
                header = row.find('th')
                value = row.find('td')
                if header and value:
                    header_text = header.get_text(strip=True)
                    infobox_data[header_text] = value.get_text(strip=True)
            page_data['정보'] = infobox_data

        # 'mw-parser-output' 내부에서 콘텐츠 추출 시작
        content_div = soup.find('div', class_='mw-parser-output')
        if not content_div:
            print("콘텐츠 영역을 찾을 수 없습니다.")
            return

        # 모든 섹션 제목(h2, h3 등)을 순서대로 찾기
        headings = content_div.find_all(['h2', 'h3', 'h4', 'h5', 'h6'])
        
        # 첫 번째 섹션(개요) 내용 추출
        intro_content_nodes = []
        current_node = content_div.find('p')
        while current_node and current_node.name != 'h2' and 'mw-empty-li' not in current_node.get('class', []):
            intro_content_nodes.append(current_node)
            current_node = current_node.find_next_sibling()
        
        intro_texts = [node.get_text(strip=True) for node in intro_content_nodes if node.get_text(strip=True) and node.get_text(strip=True) != '[편집]']
        if intro_texts:
            page_data['개요'] = intro_texts

        # 각 섹션 제목과 내용 매칭
        for heading in headings:
            title_span = heading.find('span', class_='mw-headline')
            if not title_span:
                continue

            title = title_span.get_text(strip=True)
            content_list = []
            
            # 현재 헤딩의 다음 형제 노드부터 순회 시작
            current_sibling = heading.find_next_sibling()
            
            # 다음 헤딩 태그를 만날 때까지 콘텐츠 수집
            while current_sibling and current_sibling.name not in ['h2', 'h3', 'h4', 'h5', 'h6']:
                text = current_sibling.get_text(strip=True)
                # '[편집]' 및 불필요한 공백 제거
                text = text.replace('[편집]', '').strip()
                if text:
                    # 각 줄을 분리하여 리스트로 추가
                    lines = text.split('\n')
                    for line in lines:
                        cleaned_line = line.strip()
                        if cleaned_line:
                            content_list.append(cleaned_line)
                
                current_sibling = current_sibling.find_next_sibling()

            # 수집된 콘텐츠를 딕셔너리에 추가
            if content_list:
                # 같은 제목으로 여러 섹션이 있을 경우 리스트로 병합
                if title in page_data:
                    page_data[title].extend(content_list)
                else:
                    page_data[title] = content_list

        # 파일명 생성 및 JSON 저장
        filename = f"{search_keyword}_wiki.json"
        with open(filename, 'w', encoding='utf-8') as f:
            json.dump(page_data, f, ensure_ascii=False, indent=4)
        
        print(f"크롤링이 완료되었으며, '{filename}' 파일에 JSON 형식으로 저장되었습니다.")
        print(f"생성된 JSON 키: {list(page_data.keys())}")

    except requests.exceptions.RequestException as e:
        print(f"웹 요청 중 오류가 발생했습니다: {e}")
    except Exception as e:
        print(f"오류가 발생했습니다: {e}")

# 함수 사용 예시
keyword = "푸른 바다의 전설"
crawl_and_save_wiki_sections_to_json(keyword)