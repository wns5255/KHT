# RAG 기반 K-Drama 관광 플랫폼 (KHT)

**RAG를 통한 드라마 촬영지 추출 데이터 + 공공 관광데이터 기반 K-드라마 관광 플랫폼**

🏆 **2025 한국관광데이터 활용 공모전 _장려상_ 수상 프로젝트**

---

## 📌 프로젝트 소개

이 저장소는 한국 드라마 촬영지 정보를 기반으로, 실제 여행에 활용 가능한 **K-드라마 관광 플랫폼**을 구현한 코드와 데이터를 포함합니다.

RAG(Retrieval-Augmented Generation)와 공공데이터를 결합하여:

- 드라마/배우/지역/키워드 기반 촬영지 검색
- 촬영지와 인근 관광지·맛집·숙소 매칭
- 지도 기반 시각화 및 코스 추천
- 드라마 팬·관광객·지자체 모두가 활용 가능한 서비스 프로토타입

을 제공하는 것을 목표로 합니다.

---

## 💡 주요 기능

### 1. 촬영지 추출 (RAG 파이프라인)

- 드라마 관련 텍스트(시놉시스, 기사, 설명 등)를 기반으로 촬영지 후보 자동 추출
- LLM + 벡터 검색 기반 RAG로 아래 정보 구조화:
  - 촬영지명
  - 등장 작품/에피소드/배우 정보
  - 행정구역 및 좌표 후보
- 중복/오류 데이터 정제 후 CSV/JSON 형태로 제공
<p align="center">
  <img width="420" alt="image" src="https://github.com/user-attachments/assets/9ab9350c-7803-465d-ae31-39a34bb1bf76" />
  <img width="420" alt="image" src="https://github.com/user-attachments/assets/5e899e1d-04eb-4d7f-9adc-c54947bc3fde" />
</p>

### 2. 공공데이터 매칭

- 한국관광공사, 공공데이터 포털 등에서 수집한:
  - 관광지/음식점/카페/숙박 정보
  - 주소, 좌표, 카테고리, 설명, 이미지
- 촬영지와 공공데이터 매칭을 통해  
  **“드라마 속 장소 → 실제 방문 가능한 관광 코스”** 구성
<p align="center">
  <img width="420" alt="image" src="https://github.com/user-attachments/assets/23551868-067d-4292-bdfd-5d76295e9ec3" />
  <img width="420" alt="image" src="https://github.com/user-attachments/assets/c2c79d3b-9838-4fd9-8248-9582133bfff5" />
</p>

### 3. 지도 기반 UI

- **Kakao Maps JavaScript API** 사용
- 촬영지/관광지 리스트와 지도 마커 연동
- 항목 클릭 시:
  - 해당 위치로 지도 이동
  - 인포윈도우/팝업에 상세 정보 표시
- (선택) OpenLayers + WMTS 오버레이로 역사/테마 레이어 확장 가능
<p align="center">
  <img width="420" alt="image" src="https://github.com/user-attachments/assets/9f82a747-41e2-49ff-9c4d-82944594b33c" />
</p>
### 4. 코스 추천 및 사용자 기능

- 사용자가 선택한 촬영지 기반 **코스 자동 추천**
- 즐겨찾기(보관함), 필터, 정렬 등 UX 기능
- 1일 코스 / 주말 코스 / 작품별 성지순례 코스 등 시나리오 구성 가능

---

## 🛠 기술 스택

### Frontend

- HTML5, CSS3, JavaScript (Vanilla)
- Kakao Maps JavaScript API
- (옵션) OpenLayers (WMTS, 타일 오버레이)

### Backend / Data (설계 기준)

- RAG 파이프라인 (별도 서버 또는 API)
  - 벡터 검색 엔진
  - LLM 기반 정보 추출/정제
- 데이터 가공 스크립트
  - Python 등으로 공공데이터 정제 및 매핑
- 출력 포맷
  - `CSV`, `JSON` (클라이언트에서 바로 활용 가능하도록 구조화)

---

## 📂 디렉토리 구조

```bash
.
├── server.py # 메인 서버
├── actor_mode_crawler_and_aggregator.py # 배우가 촬영한 드라마 크롤링(나무위키)
├── append_coords.py # 데이터 전처리 
├── data/
│   ├── drama_list.csv # 드라마 촬영지 데이터
│   └── users.csv     # 로그인 정보
├── main_pipeline.py    # 촬영지 추출 RAG 파이프라인
├── data_cleaning.py    # 전처리/매칭 스크립트
├── kakao_geocode.py    # 드라마 촬영장소에 대한 주소지 검색 (카카오)
├── namu_drama_crawler.py # 드라마 정보 크롤링 (나무위키)
├── drama.py # 드라마 정보 전처리
├── csvSearch.py # 드라마 촬영지에 대한 공공 데이터 처리
├── google.py # 드라마 촬영 정보에 대한 구글 서치 api 사용
└── README.md
```

---

## 🚀 실행 방법

### 1. 사전 준비

1. **Kakao Maps API 키** 발급
2. `index.html` 또는 `app.js` 내 스크립트 URL의 `appkey` 값을 발급받은 키로 교체
3. (옵션) RAG/백엔드 서버 주소 설정
   - `app.js` 내 `API_BASE` 상수 등으로 관리

### 2. 로컬 실행

정적 페이지 형태이므로 간단한 HTTP 서버로 실행 가능합니다.

```bash
git clone https://github.com/<YOUR-ID>/KHT.git
cd KHT

# Python 내장 서버 사용 예시
python -m http.server 8000

# 또는 node serve 사용 시
# npx serve .
```

브라우저에서 아래 주소 접속:

```text
http://localhost:8000
```

---

## 📡 환경 변수 / 설정 (예시)

```js
// config.example.js
const CONFIG = {
  KAKAO_API_KEY: "YOUR_KAKAO_API_KEY",
  API_BASE: "https://your-rag-server/api", // 없으면 주석 처리 가능
};
```

`config.js`로 복사 후 실제 키와 URL 입력, `index.html`에서 로드하여 사용.

---

## 📊 데이터 출처

- 한국관광공사 관광정보 API
- 공공데이터 포털(지자체 관광/문화/숙박 데이터)
- 드라마 공식 홈페이지 및 공개 자료
- 기타 활용 조건을 충족하는 공개 데이터

모든 데이터는 각 제공처의 라이선스 및 이용 약관을 준수하며 사용했습니다.  
실제 서비스 운영 시 재확인이 필요합니다.

---

## 🏅 수상 내역

**2025 한국관광데이터 활용 공모전 – 장려상**

- 공공데이터와 생성형 AI(RAG)를 결합하여
  - K-드라마 촬영지 기반 관광 동선을 자동 구성하고,
  - 실제 방문 가능한 장소와 연결하는 데이터 파이프라인 및 웹 프로토타입을 구현
- 데이터 활용성, 서비스 확장성, 관광 활성화 기여 가능성에서 우수 평가를 받음

---

## 🔮 향후 계획

- 더 많은 드라마/영화/예능 촬영지 데이터 확장
- 사용자 행동 로그 기반 추천 고도화
- 다국어 지원 및 해외 K-컬쳐 팬 대상 서비스 확장
- 역사 RAG·메타버스 프로젝트와의 통합 (K-heritage, 공간 스토리텔링 등)
