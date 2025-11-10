
/* =========================
    * Config / Globals
    * ========================= */
const API_BASE = "https://rag.magiclab.kr";
const COLORS = ["#5b9cff", "#22c55e", "#f59e0b", "#ef4444", "#a78bfa", "#06b6d4", "#f472b6"];
const MOBILE_Q = window.matchMedia("(max-width: 759px)");

let LAST_KEYWORD = ""; // 마지막 검색 키워드(작품/배우)
let last = null; // 마지막 검색 결과 데이터
let map, clusterer, infoWin;
let overlays = [],
    polylines = [],
    idToLatLng = {};
const markerById = {}; // placeId -> kakao.maps.Marker
const placeIdToCourseIdx = {}; // placeId -> 첫 포함 코스 인덱스
let activePlaceId = null;
let openMobileCourseIdx = null; // 현재 열려있는 모바일 코스 섹션 인덱스
let _favDragging = false;
// === [PATCH: drag-state reset] 보관함 드래그가 중간에 끊겨도 클릭이 먹히도록 안전장치 ===
window.addEventListener('mouseup',   () => { try{ _favDragging = false; }catch{} }, true);
window.addEventListener('dragend',   () => { try{ _favDragging = false; }catch{} }, true);
window.addEventListener('touchend',  () => { try{ _favDragging = false; }catch{} }, { passive:true });
window.addEventListener('blur',      () => { try{ _favDragging = false; }catch{} });
document.addEventListener('mouseleave', () => { try{ _favDragging = false; }catch{} }, true);
// === [END PATCH] ===


/* =========================
 * Utils
 * ========================= */
const qs = s => document.querySelector(s);
const qsa = s => Array.from(document.querySelectorAll(s));
const on = (id, ev, fn) => document.getElementById(id)?.addEventListener(ev, fn);

const letter = (n) => {
    const A = 65;
    let s = "";
    n++;
    while (n > 0) {
        const r = (n - 1) % 26;
        s = String.fromCharCode(A + r) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}
const toast = (t) => {
    const el = qs("#toast");
    el.textContent = t;
    el.classList.add("show");
    setTimeout(() => el.classList.remove("show"), 1200)
};
const escapeHtml = (str) => (str ?? "").toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const ytThumb = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const ensureSheetHeight = (p = 0.62) => {
    try {
        openSheetToPercent?.(p)
    } catch (e) {}
};
window._courseReorderLock = false;
// --- SAFE bottom sheet opener: use `top`, clear any transform (iOS hit-test fix)
// === 모바일 하단 시트 높이 변경 (안정판) ===
window.openSheetToPercent = function (p = 0.62) {
  const sh = document.getElementById('sheet');
  if (!sh) return;
  // p: 0.0(맨 위) ~ 1.0(바닥). 0.62면 화면 높이의 62% 지점에 top 고정
  const vh = Math.max(0, Math.min(100, Math.round(p * 100)));
  sh.style.top = vh + 'vh';
  sh.style.transform = '';           // translateY 잔재 제거(히트 오류 방지)
  sh.style.willChange = 'top';
  // ★ 레이아웃 즉시 확정 → 히트테스트 오프셋 방지
  void sh.offsetHeight;
  sh.style.pointerEvents = 'auto';
  const body = sh.querySelector('.sheet-body');
  if (body) body.style.pointerEvents = 'auto';
};

// === Sheet 오토-닫힘 차단 & 다시 열기 유틸 ===
window._sheetHoldUntil = 0;
window.keepSheetOpen = function(min = 0.62, ms = 450){
  try { openSheetToPercent?.(min); } catch {}
  window._sheetHoldUntil = Date.now() + ms;  // 이 시간까지는 스냅/닫힘 무시
};


/* ===== Pretty placeholder thumbnail (SVG data URL) ===== */
function _hashHue(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h % 360;
}

function _paletteFromTitle(title) {
    const h = _hashHue((title || '관광지') + 'kht');
    const c1 = `hsl(${h}, 72%, 58%)`;
    const c2 = `hsl(${(h+28)%360}, 70%, 42%)`;
    return [c1, c2];
}

function _iconPathByType(type) {
    // 간단한 아이콘들 (tour: 핀, hotel: 침대, food: 포크&나이프)
    if (type === 'hotel')
        return 'M20 28v-6h24v6m-24 0v8h24v-8M14 22h36v18a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4z';
    if (type === 'food')
        return 'M22 14v28m8-28v28m-8-14h8M42 14v15a5 5 0 0 0 10 0V14';
    // tour / default: map pin
    return 'M32 8c-9 0-16 7-16 16 0 11 16 28 16 28s16-17 16-28c0-9-7-16-16-16zm0 10a6 6 0 110 12 6 6 0 010-12z';
}

function makePlaceholderThumb(title = '', type = 'tour') {
    const raw = (title || '장소').slice(0, 12);
    const label = raw.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const [c1, c2] = _paletteFromTitle(title || type);
    const icon = _iconPathByType(type);
    const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 64 48">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="${c1}"/>
          <stop offset="1" stop-color="${c2}"/>
        </linearGradient>
      </defs>
      <rect width="64" height="48" rx="6" fill="url(#g)"/>
      <g opacity=".12">
        <circle cx="12" cy="10" r="6" fill="#fff"/>
        <circle cx="54" cy="40" r="5" fill="#fff"/>
        <circle cx="42" cy="8"  r="4" fill="#fff"/>
      </g>
      <path d="${icon}" fill="#ffffff" opacity=".9"/>
      <rect x="4" y="36" width="56" height="8" rx="4" fill="#000" opacity=".22"/>
      <text x="32" y="42" text-anchor="middle" font-family="system-ui, -apple-system, Segoe UI, Roboto, Noto Sans KR"
            font-size="6.2" fill="#fff" font-weight="700">${label}</text>
    </svg>`;
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}


function detectKindFromWork(w) {
    const k = String(w.kind || '').toLowerCase();
    if (k === 'film' || k === 'tv') return k; // ← 서버 값 신뢰
    const provider = (w.network || w.platform || w.provider || '').toLowerCase();
    if (/(jtbc|kbs|mbc|sbs|tvn|ena|wavve|tving|netflix)/.test(provider)) return 'tv';
    if (Number(w.episodes) > 1 || Number(w.seasons) >= 1) return 'tv';
    if (/시즌|season/i.test(w.title || '')) return 'tv';
    return 'tv'; // 최후의 보루
}

function loadingOn() {
    qs("#loadingOverlay").classList.add("show");
}

function loadingOff() {
    qs("#loadingOverlay").classList.remove("show");
}

function decodeHtml(str) {
    const ta = document.createElement('textarea');
    ta.innerHTML = String(str ?? '');
    return ta.value;
}

function setLoadingProgress(stage, label) {
    const pct = Math.max(0, Math.min(100, stage <= 0 ? 0 : stage >= 5 ? 100 : Math.round((stage / 5) * 100)));
    let box = document.getElementById("ktrip-progress");
    if (!box) {
        box = document.createElement("div");
        box.id = "ktrip-progress";
        box.style.cssText = "position:fixed;right:16px;bottom:16px;background:rgba(0,0,0,.72);color:#fff;padding:10px 14px;border-radius:12px;font-weight:600;z-index:99999;box-shadow:0 4px 14px rgba(0,0,0,.25);font-size:14px";
        const text = document.createElement("div");
        text.id = "ktrip-progress-text";
        text.style.marginTop = "2px";
        const wrap = document.createElement("div");
        wrap.style.cssText = "width:220px;height:6px;background:rgba(255,255,255,.12);border-radius:99px;margin-top:8px";
        const bar = document.createElement("div");
        bar.id = "ktrip-progress-bar";
        bar.style.cssText = "height:100%;width:0%;background:#4f8cff;border-radius:99px;transition:width .3s ease";
        wrap.appendChild(bar);
        box.appendChild(text);
        box.appendChild(wrap);
        document.body.appendChild(box);
    }
    const bar = document.getElementById("ktrip-progress-bar");
    const text = document.getElementById("ktrip-progress-text");
    if (bar) bar.style.width = pct + "%";
    if (text) text.textContent = `${pct}%  ${label || ""}`.trim();
    if (pct >= 100) setTimeout(() => box?.remove(), 1000);
}

async function upsertFavorite({
    id,
    title,
    addr,
    lat,
    lng
}, add = true) {
    if (!auth?.user) {
        toast('로그인이 필요합니다');
        return false;
    }
    const url = '/api/user/favorites' + (add ? '' : `/${encodeURIComponent(id)}`);
    const opts = add ? {
            method: 'POST',
            body: JSON.stringify({
                id,
                title,
                addr,
                lat,
                lng
            })
        } :
        {
            method: 'DELETE'
        };
    const r = await reqJSON(url, opts);
    if (r.ok) {
        // 세트/캐시 반영
        add ? favSet.add(id) : favSet.delete(id);
        const rest = (window.myFavItems || []).filter(x => x.id !== id);
        window.myFavItems = add ? [...rest, {
            id,
            title,
            addr,
            lat: +lat,
            lng: +lng
        }] : rest;
        applyFavOrderLocally(window.myFavItems);
        // UI 동기화
        reflectFavoriteUI(id, add);   // ★ 즉시 UI 반영
        await syncFavorites().catch(() => {});
        if (document.querySelector('.tabs .tab.active')?.dataset.tab === 'mine') {
            updateMapByContext('mine');
        }
    }
    return !!r.ok;
}

/* =========================
 * Map init
 * ========================= */
function initMap() {
    const center = new kakao.maps.LatLng(37.5665, 126.9780);
    map = new kakao.maps.Map(qs("#map"), {
        center,
        level: 8
    });
    clusterer = new kakao.maps.MarkerClusterer({
        map,
        averageCenter: true,
        minLevel: 8,
        gridSize: 28,
        minClusterSize: 3,
        styles: [{
            width: "40px",
            height: "40px",
            background: "rgba(91,156,255,.9)",
            color: "#02112e",
            textAlign: "center",
            lineHeight: "40px",
            borderRadius: "20px",
            border: "2px solid #0b1326",
            boxShadow: "0 8px 22px rgba(0,0,0,.35)"
        }]
    });
    infoWin = new kakao.maps.InfoWindow({
        zIndex: 10
    });

    // 직접 추가
    kakao.maps.event.addListener(map, 'rightclick', async (ev) => {
        if (!auth.user) {
            toast('로그인이 필요합니다');
            return;
        }
        if (!courseDraft) {
            toast('상단 "내 코스 만들기" 후 우클릭하세요');
            return;
        }
        const lat = ev.latLng.getLat(),
            lng = ev.latLng.getLng();
        const title = prompt('장소 이름을 입력하세요');
        if (!title) return;
        courseDraft.spots.push({
            id: `custom_${Date.now()}`,
            title,
            subtitle: '(사용자 추가)',
            lat,
            lng
        });
        toast('코스에 사용자 장소 추가 완료');
    });
}

function bootKakao(cb) {
    // 이미 로드된 경우
    if (window.kakao?.maps?.Map) {
        cb();
        return;
    }
    // autoload=false 로더가 준비된 경우
    if (window.kakao?.maps?.load) {
        window.kakao.maps.load(cb);
        return;
    }
    // 스크립트 태그 load 이벤트에 연결
    const tag = document.querySelector('script[src*="dapi.kakao.com/v2/maps/sdk.js"]');
    if (tag && !tag.dataset._bind) {
        tag.dataset._bind = "1";
        tag.addEventListener('load', () => window.kakao.maps.load(cb));
    } else {
        // 드물게 load 이벤트를 못잡는 경우 대비 폴링
        const t = setInterval(() => {
            if (window.kakao?.maps?.load) {
                clearInterval(t);
                window.kakao.maps.load(cb);
            }
        }, 50);
        setTimeout(() => clearInterval(t), 8000);
    }
}

// 여기서 초기화
bootKakao(initMap);

window.renderMobileMine = function() {
    const box = document.getElementById('m-mine');
    if (!box) return;
    const items = (window.myFavItems || []);
    if (!items.length) {
        box.innerHTML = '<div class="empty">보관함이 비어있습니다</div>';
        return;
    }
    box.innerHTML = items.map((r, i) => `
      <div class="item" data-fid="${r.id}" data-lat="${+r.lat}" data-lng="${+r.lng}">
        <div class="label">${i + 1}</div>
        <div>
          <div class="title">${escapeHtml(r.title||'')}</div>
          <div class="addr">${escapeHtml(r.addr||'')}</div>
          <div style="display:flex;gap:6px;margin-top:6px">
            <button class="btn-delete ghost" type="button">삭제</button>
          </div>
        </div>
      </div>
    `).join('');

    // ✅ (추가) 모바일 보관함 리스트 클릭 위임
    box.onclick = async (e) => {
        const delBtn = e.target.closest('.btn-delete');
        const host   = e.target.closest('.item[data-fid]');
        if (!host) return;

        const id   = host.dataset.fid;

        if (delBtn) {
            if (confirm('이 장소를 보관함에서 삭제할까요?')) {
            const ok = await deleteFavoriteById(id);
            if (ok){
                renderMobileMine();  // 리스트 즉시 리렌더
                updateMapByContext('mine'); // 모바일에서도 즉시 지도 동기화 (이미 잘 되면 생략 가능)
            }

            }
            return;
        }

        // 아이템 선택 → 지도/리스트 동기화(삭제 외 동작 그대로 유지)
        selectPlace(id, { pan:true, ping:true });
        // 아이템 선택 → 먼저 지도 컨텍스트를 보관함으로 전환 후 선택
        try { updateMapByContext?.('mine'); } catch {}
        selectPlace(id, { pan:true, ping:true });
        try { openSheetToPercent?.(0.62); } catch {}
    };


};


/* =========================
 * SSE 진행 배지
 * ========================= */
let CURRENT_REFRESH_TITLE = null;

/* =========================
 * Map helpers
 * ========================= */



function clearMap() {
    clusterer.clear();
    overlays.forEach(o => o.setMap && o.setMap(null));
    overlays = [];
    polylines.forEach(p => p.setMap(null));
    polylines = [];
    idToLatLng = {};
    Object.keys(markerById).forEach(k => delete markerById[k]);
}

function simpleMarker(latlng, title, subtitle, id) {
    const m = new kakao.maps.Marker({
        position: latlng,
        title: title || ""
    });
    if (id) markerById[id] = m;
    kakao.maps.event.addListener(m, 'click', () => {
        if (id) selectPlace(id, {
            pan: false,
            ping: true
        });
        infoWin.setContent(
        `<div style="padding:6px 8px">
            <b>${escapeHtml(title||"")}</b>
            <div style="color:#9fb9e8;font-size:12px">${escapeHtml(subtitle||"")}</div>
        </div>`
        );
        infoWin.open(map, m);
    });
    m.setMap(map);
    overlays.push(m);
    return m;
}

function highlightMarker(marker) {
    Object.values(markerById).forEach(m => m.setZIndex(0));
    marker.setZIndex(1000);
    // 강조 링
    const pos = marker.getPosition();
    const ring = new kakao.maps.Circle({
        center: pos,
        radius: 30,
        strokeWeight: 3,
        strokeColor: '#5b9cff',
        strokeOpacity: 0.9,
        strokeStyle: 'solid',
        fillColor: 'rgba(0,0,0,0)',
        fillOpacity: 0
    });
    ring.setMap(map);
    setTimeout(() => ring.setMap(null), 900);
}

function pingOverlay(latlng) {
    const node = document.createElement('div');
    node.className = 'ping';
    const ov = new kakao.maps.CustomOverlay({
        position: latlng,
        content: node,
        xAnchor: 0.5,
        yAnchor: 0.5,
        zIndex: 2000
    });
    ov.setMap(map);
    setTimeout(() => ov.setMap(null), 1200);
}

// 현재 보여줄 핀들만 지도에 반영
function setMarkersForPins(pins, {
    fit = true
} = {}) {
    clearTourLayer?.(); // 관광API 레이어가 켜져있으면 지움
    clearMap(); // 기존 마커/오버레이/클러스터 초기화
    const toClusterer = [];
    const b = new kakao.maps.LatLngBounds();
    pins.forEach(p => {
        if (typeof p.lat !== "number" || typeof p.lng !== "number") return;
        const ll = new kakao.maps.LatLng(p.lat, p.lng);
        idToLatLng[p.id] = ll;
        b.extend(ll);
        toClusterer.push(simpleMarker(ll, p.title, p.subtitle, p.id));
    });
    if (toClusterer.length) clusterer.addMarkers(toClusterer);
    if (b && typeof b.isEmpty === 'function' && !b.isEmpty()) map.setBounds(b);
}

function getCoursePinsOnly() {
    const pins = last?.pins || [];
    const byId = Object.fromEntries(pins.map(p => [p.id, p]));
    const set = new Set();
    (last?.courses || []).forEach(c => {
        const ids = (Array.isArray(c.spots) && c.spots.length) ? c.spots : (c.route_order || []);
        ids.forEach(id => set.add(id));
    });
    return [...set].map(id => byId[id]).filter(Boolean);
}

// 탭 컨텍스트에 따라 지도 갱신
function updateMapByContext(ctx) {
    const context = ctx || document.querySelector('.tabs .tab.active')?.dataset.tab || 'results';
    if (context === 'courses') {
        setMarkersForPins(getCoursePinsOnly(), {
            fit: true
        });
        polylines.forEach(p => p.setMap(null)); // 기존 라인 지우고
        drawRoutesFromCourses(last?.pins || [], last?.courses || []); // 코스 라인 다시 그림
    } else if (context === 'mine') {
        if (!auth?.user) {
            clearMap();
            toast('로그인하면 보관함 핀을 볼 수 있어요');
            return;
        }

        const favPins = (window.myFavItems || []).map((r, i) => ({
            id: r.id,
            title: r.title,
            subtitle: r.addr,
            lat: +r.lat,
            lng: +r.lng
        }));
        setMarkersForPins(favPins, {
            fit: true
        });

        // ▼ 기존 라인 지우고
        polylines.forEach(p => p.setMap(null));
        polylines = [];

        // ▼ 보관함 순서대로 경로를 다시 그림 (사용자가 드래그로 정한 순서가 그대로 반영됨)
        if (favPins.length >= 2) {
            const path = favPins.map(p => new kakao.maps.LatLng(p.lat, p.lng));
            const line = new kakao.maps.Polyline({
                path,
                strokeWeight: 3,
                strokeColor: '#5b9cff',
                strokeOpacity: 0.9,
                strokeStyle: 'solid'
            });
            line.setMap(map);
            polylines.push(line);
        }
    } else {
        setMarkersForPins(last?.pins || [], {
            fit: true
        }); // 검색결과 핀
        polylines.forEach(p => p.setMap(null)); // 결과 탭에선 라인 숨김
    }
}

// 다른 전역들과 같이 배치
let mineRoutePreview = null;

function updateMineRoutePreviewByOrderIds(orderIds) {
    if (!map || !orderIds?.length) return;
    const pins = orderIds
        .map(id => (window.myFavItems || []).find(x => x.id === id))
        .filter(p => p && Number.isFinite(+p.lat) && Number.isFinite(+p.lng))
        .map(p => new kakao.maps.LatLng(+p.lat, +p.lng));

    if (mineRoutePreview) {
        mineRoutePreview.setMap(null);
        mineRoutePreview = null;
    }
    if (pins.length >= 2) {
        mineRoutePreview = new kakao.maps.Polyline({
            path: pins,
            strokeWeight: 3,
            strokeColor: '#5b9cff',
            strokeOpacity: 0.6,
            strokeStyle: 'dash' // ← 드래그 중엔 점선으로
        });
        mineRoutePreview.setMap(map);
    }
}

/* =========================
 * Cards / Rendering
 * ========================= */
function showMetaCard(meta) {
    const box = document.getElementById("panel-results");
    if (!box) return;

    const id = "metaCard";
    let el = document.getElementById(id);
    if (!el) {
        el = document.createElement("div");
        el.id = id;
        box.prepend(el);
    }

    const poster = meta?.poster?.file || meta?.poster?.url || meta?.poster || "";
    const titleKo = meta?.title_ko || meta?.title || "";
    const subKo = [meta?.title_en || "", meta?.released || ""].filter(Boolean).join(" · ");
    const castArr = Array.isArray(meta?.cast) ? meta.cast.slice(0, 15) : [];
    const castTxt = castArr.length ? escapeHtml(castArr.join(" · ")) : "";

    // PC: 세로 카드 / 모바일: 기존 모바일 카드(#m-meta-card) 사용
    el.innerHTML = `
      <div class="meta-poster">
        ${ poster
          ? `<img src="${poster}" alt="${(titleKo||'').replace(/"/g,'&quot;')}" loading="lazy">`
          : `<div style="height:180px;display:grid;place-items:center;color:#9ca3af">포스터 없음</div>` }
      </div>
      <div class="meta-title">${escapeHtml(titleKo||"")}</div>
      ${ subKo ? `<div class="meta-sub">${escapeHtml(subKo)}</div>` : "" }
      ${ castTxt ? `<div class="meta-cast">${castTxt}</div>` : "" }
    `;
}

function renderWorkCard(meta) {
    const card = qs("#workCard");
    // 모바일에서는 별도 고정 카드 사용 안함 (시트 안에 내장 카드로 표시)
    if (MOBILE_Q.matches) {
        if (card) {
            card.style.display = "none";
            card.innerHTML = "";
        }
        return;
    }
    if (!meta) {
        if (card) {
            card.style.display = "none";
            card.innerHTML = "";
        }
        return;
    }

    const esc = escapeHtml;
    const titleKo = esc(meta?.title_ko || meta?.title || "");
    const titleEn = esc(meta?.title_en || "");
    const released = esc(meta?.released || (meta?.air_dates?.start || ""));
    const poster = meta?.poster?.file || meta?.poster?.url || "";
    const castArr = Array.isArray(meta?.cast) ? meta.cast.map(esc) : [];
    const castText = castArr.slice(0, 10).join(", ") + (castArr.length > 10 ? ` 외 ${castArr.length - 10}명` : "");
    const sequelTitle = esc(meta?.sequel?.title || "");
    const sequelUrl = meta?.sequel?.url || "";
    const sequel = meta?.sequel?.title ? `<a href="${sequelUrl}" target="_blank" rel="noopener">${sequelTitle}</a>` : "";
    card.innerHTML = `
      <div class="head">
        <div class="title">${titleKo}</div>
        <div style="margin-left:auto;opacity:.7">${titleEn}</div>
        <button class="close" aria-label="닫기">×</button>
      </div>
      <div class="body">
        ${poster ? `<div class="poster"><img src="${poster}" alt="${titleKo} 포스터" /></div>` : ""}
        <div class="info">
          ${released ? `<div class="row"><b>공개일</b> · ${released}</div>` : ""}
          ${sequel ? `<div class="row"><b>후편</b> · ${sequel}</div>` : ""}
          ${castArr.length ? `<div class="row cast"><b>출연</b> · ${castText}</div>` : ""}
        </div>
      </div>
      <div class="foot"><div style="color:#93c5fd;font-size:12px">장소를 클릭하면 지도에 표시됩니다</div></div>`;
    card.style.display = "block";
    card.querySelector(".close").onclick = () => {
        card.style.display = "none";
    };
}

function buildResultsPins(pins) {
    const box = qs("#panel-results");
    if (!pins.length) {
        box.innerHTML = `<div class="empty">검색 결과가 없습니다</div>`;
        return;
    }
    const list = pins.map((p, i) => {
        const isFav = favSet?.has?.(p.id);
        return `
        <div class="item" data-id="${p.id}" data-lat="${p.lat}" data-lng="${p.lng}">
            <button class="btn-fav ghost" type="button" title="즐겨찾기">${isFav ? '★' : '☆'}</button>
        
        <div class="label">${i + 1}</div>
        <div>
            <div class="title">${escapeHtml(p.title||"")}</div>
            <div class="addr">${escapeHtml(p.subtitle||"")}</div>
            <div class="meta">위도 ${p.lat?.toFixed(5)} / 경도 ${p.lng?.toFixed(5)}</div>
            <div style="display:flex;gap:6px;margin-top:6px">
                    <button class="btn-detail" type="button">상세보기</button>
                    <button class="btn-to-course ghost" type="button">➕ 코스담기</button>
                    <!-- 즐겨찾기된 항목만 삭제 버튼 노출 -->
                    <button class="btn-remove ghost" type="button" style="display:${isFav ? 'inline-flex' : 'none'}">삭제</button>
                </div>
            </div>
        </div>`;
    }).join("");
    box.innerHTML = list;
    box.querySelectorAll('.item[data-id]').forEach(it => {
        it.tabIndex = 0;
        it.setAttribute('role', 'button');
        it.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                dismissKeyboard();
                selectPlace(it.getAttribute('data-id'), {
                    pan: true,
                    ping: true
                });
            }
        });
    });

    // 리스트 클릭 → 지도/선택 동기화 (상세보기 버튼은 위임)
    box.onclick = async (e) => {
        const favBtn = e.target.closest('.btn-fav');
        // (PC) buildResultsPins() 안의 위임 핸들러에서
        if (favBtn) {
            if (!auth.user) {
                toast('로그인이 필요합니다');
                return;
            }
            const host = e.target.closest('.item');
            const id = host.dataset.id;
            const lat = +host.dataset.lat,
                lng = +host.dataset.lng;
            const title = host.querySelector('.title')?.textContent || '';
            const addr = host.querySelector('.addr')?.textContent || '';
            const isFav = favSet.has(id);

            const ok = await upsertFavorite({
                id,
                title,
                addr,
                lat,
                lng
            }, !isFav);
            if (ok) {
              // upsertFavorite()가 favSet 동기화 및 서버 반영을 이미 수행
              favBtn.textContent = favSet.has(id) ? '★' : '☆';
               // ★ 즐겨찾기 상태에 맞게 삭제 버튼 표시/숨김
              const rm = host.querySelector('.btn-remove');
              if (rm) rm.style.display = favSet.has(id) ? 'inline-flex' : 'none';
              toast(favSet.has(id) ? '즐겨찾기 추가' : '즐겨찾기 해제');
              loadMyBox();
            }
            return;
        }
            // ⬇ 삭제 버튼 처리
        const removeBtn = e.target.closest('.btn-remove');
        if (removeBtn) {
        const host = removeBtn.closest('.item');
        const id = host?.dataset.id;
        if (!id) return;
        if (confirm('이 장소를 보관함에서 삭제할까요?')) {
            const ok = await deleteFavoriteById(id);
            if (ok) {
            // UI 즉시 반영
            removeBtn.style.display = 'none';
            const favBtn2 = host.querySelector('.btn-fav');
            if (favBtn2) favBtn2.textContent = '☆';
            loadMyBox(); // 내 보관함/지도 동기화
            }
        }
        return;
        }

        const addBtn = e.target.closest('.btn-to-course');
        if (addBtn) {
            if (!auth.user) {
                toast('로그인이 필요합니다');
                return;
            }
            if (!courseDraft) {
                toast('하단 "+ 버튼"을 먼저 누르고 코스를 추가하세요');
                return;
            }
            const host = addBtn.closest('.item');
            const id = host.dataset.id;
            const lat = +host.dataset.lat,
                lng = +host.dataset.lng;
            const title = host.querySelector('.title')?.textContent || '';
            const addr = host.querySelector('.addr')?.textContent || '';
            if (!courseDraft.spots.find(s => s.id === id)) {
                courseDraft.spots.push({
                    id,
                    title,
                    subtitle: addr,
                    lat,
                    lng
                });
                toast('코스에 담겼어요');
            } else {
                toast('이미 담긴 장소입니다');
            }
            return;
        }
        const btn = e.target.closest(".btn-detail");
        if (btn) return;
        const it = e.target.closest('.item[data-id]');
        if (!it) return;
        selectPlace(it.getAttribute("data-id"), {
            pan: true,
            ping: true
        });
    };
}

function buildResultsMobilePins(pins) {
    const box = qs("#m-results");
    if (!box) return;

    // 작품 메타가 있으면 모바일용 내장 카드(세로형) 구성
    const meta = last?.meta;
    const head = meta ? (() => {
        const poster = meta.poster?.file || meta.poster?.url || meta.poster || "";
        const titleKo = meta.title_ko || meta.title || "";
        const subKo = [meta.title_en || "", meta.released || ""].filter(Boolean).join(" · ");
        const castArr = Array.isArray(meta.cast) ? meta.cast.slice(0, 15) : [];
        const castTxt = castArr.length ? escapeHtml(castArr.join(" · ")) : "";
        return `
        <div id="m-meta-card" class="meta-card-vertical"
            style="padding:10px;border-bottom:1px solid #1f2b3f;background:rgba(12,21,42,.8)">
          ${ poster
          ? `<img class="meta-poster" src="${poster}" alt="${escapeHtml(titleKo)} 포스터" loading="lazy">`
          : `<div class="poster-placeholder">포스터 없음</div>` }
          <div class="meta-title">${escapeHtml(titleKo)}</div>
          <div class="meta-sub">${escapeHtml(subKo)}</div>
          ${ castTxt ? `<div class="meta-cast">${castTxt}</div>` : "" }
        </div>`;
    })() : "";

    if (!pins.length) {
        box.innerHTML = head + `<div class="empty">검색 결과가 없습니다</div>`;
        return;
    }

    const list = pins.map((p, i) => `
      <div class="item" data-id="${p.id}" data-lat="${p.lat}" data-lng="${p.lng}">
        <button class="btn-fav ghost" type="button" title="즐겨찾기">☆</button>
        <div class="label">${i + 1}</div>
        <div>
          <div class="title">${escapeHtml(p.title||"")}</div>
          <div class="addr">${escapeHtml(p.subtitle||"")}</div>
          <div class="meta">위도 ${p.lat?.toFixed(5)} / 경도 ${p.lng?.toFixed(5)}</div>
          <div style="display:flex;gap:6px;margin-top:6px">
            <button class="btn-detail" type="button">상세보기</button>
            <button class="btn-to-course ghost" type="button">➕ 코스담기</button>
          </div>
        </div>
      </div>`).join("");
    box.innerHTML = head + list;
    box.querySelectorAll('.item[data-id]').forEach(it => {
        it.tabIndex = 0;
        it.setAttribute('role', 'button');
        it.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                dismissKeyboard();
                selectPlace(it.getAttribute('data-id'), {
                    pan: true,
                    ping: true
                });
            }
        });
    });
    // ✅ (추가) 모바일 결과 리스트 클릭 위임
    box.onclick = async (e) => {
    const favBtn = e.target.closest('.btn-fav');
    if (favBtn) {
        if (!auth.user) { toast('로그인이 필요합니다'); return; }
        const host = e.target.closest('.item');
        const id   = host.dataset.id;
        const lat  = +host.dataset.lat, lng = +host.dataset.lng;
        const title = host.querySelector('.title')?.textContent || '';
        const addr  = host.querySelector('.addr')?.textContent  || '';
        const isFav = favSet.has(id);

        const ok = await upsertFavorite({ id, title, addr, lat, lng }, !isFav);
        if (ok) {
        favBtn.textContent = favSet.has(id) ? '★' : '☆';
        toast(isFav ? '즐겨찾기 해제' : '즐겨찾기 추가');
        loadMyBox(); // 보관함 동기화
        }
        return;
    }

    const addBtn = e.target.closest('.btn-to-course');
    if (addBtn) {
        if (!auth.user) { toast('로그인이 필요합니다'); return; }
        if (!courseDraft) { toast('하단 "+ 버튼"을 먼저 누르고 코스를 추가하세요'); return; }
        const host = addBtn.closest('.item');
        const id   = host.dataset.id;
        const lat  = +host.dataset.lat, lng = +host.dataset.lng;
        const title = host.querySelector('.title')?.textContent || '';
        const addr  = host.querySelector('.addr')?.textContent  || '';
        if (!courseDraft.spots.find(s => s.id === id)) {
        courseDraft.spots.push({ id, title, addr, lat, lng });
        toast('코스에 담겼어요');
        } else {
        toast('이미 담긴 장소입니다');
        }
        return;
    }

    const btn = e.target.closest(".btn-detail");
    if (btn) return; // 상세보기는 이미 전용 핸들러 있음

    const it = e.target.closest('.item[data-id]');
    if (!it) return;
    // 선택/지도 연동
    selectPlace(it.getAttribute('data-id'), { pan:true, ping:true });
    try { openSheetToPercent?.(0.62); } catch {}
    };


}

function buildCourses(pins, courses) {
    const box = qs("#panel-courses");
    if (!pins.length) {
        box.innerHTML = `<div class="empty">코스가 없습니다</div>`;
        return;
    }
    const pinById = Object.fromEntries(pins.map(p => [p.id, p]));
    const html = (courses || []).map((c, idx) => {
        const color = COLORS[idx % COLORS.length];
        const ids = (Array.isArray(c.spots) && c.spots.length) ? c.spots : (c.route_order || []);
        const name = c.title || c.region || `코스 ${idx+1}`;
        const desc = (typeof c.distance_km === "number") ? `약 ${c.distance_km}km` : (c.itinerary || "");
        const li = ids.map((id, i) => {
            const p = pinById[id];
            if (!p) return "";
            return `<div class="item" data-id="${id}">
                    <div class="label" style="background:${color}">${letter(i)}</div>
                        <div class="title">${escapeHtml(p.title||"")}</div>
                        <div class="addr">${escapeHtml(p.subtitle||"")}</div>
                    </div>`;
        }).join("");
        return `
        <section class="course" data-idx="${idx}">
          <div class="course-header" data-idx="${idx}" style="padding:10px;background:transparent;cursor:pointer">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:10px">
              <div style="display:flex;align-items:center;gap:8px">
                <div class="label" style="background:${color}">${idx+1}</div>
                <b>${name}</b>
                <span class="addr" style="margin-left:6px;opacity:.8">${desc}</span>
              </div>
              <div style="display:flex;gap:6px">
                <button class="ghost" data-act="zoom" data-idx="${idx}" title="이 코스로 지도의 중심 이동">확대하기</button>
                <button class="ghost caret" data-act="expand" data-idx="${idx}" aria-expanded="false">펼치기 ▾</button>
              </div>
            </div>
          </div>
          <div class="course-items" data-idx="${idx}" style="display:none">
            ${li || '<div class="empty">장소 없음</div>'}
          </div>
        </section>`;
    }).join("");
    box.innerHTML = html;

    // ★ 렌더 후, 이전에 열려있던 섹션 복원
    if (openMobileCourseIdx != null) {
        const secs = box.querySelectorAll('section.m-course');
        const sec = secs[openMobileCourseIdx];
        if (sec) toggleMobileCoursePanel(sec, box);
    }

    // 이벤트 위임
    box.onclick = (e) => {
        const btnExpand = e.target.closest('button[data-act="expand"]');
        const btnZoom = e.target.closest('button[data-act="zoom"]');
        const header = e.target.closest('.course-header');
        const item = e.target.closest('.item[data-id]');

        if (btnZoom) {
            const idx = +btnZoom.dataset.idx;
            const c = courses[idx];
            const ids = ((Array.isArray(c.spots) && c.spots.length) ? c.spots : (c.route_order || [])).filter(id => idToLatLng[id]);
            if (!ids.length) return;
            const b = new kakao.maps.LatLngBounds();
            ids.forEach(id => b.extend(idToLatLng[id]));
            map.setBounds(b);
            if (MOBILE_Q.matches) map.setLevel(Math.max(3, map.getLevel() - 1));
            return;
        }
        if (btnExpand || header) {
            const sec = (btnExpand || header).closest('section.course');
            toggleCoursePanel(sec, box);
            return;
        }
        if (item) {
            selectPlace(item.dataset.id, {
                pan: true,
                ping: true
            });
            return;
        }
    };

    indexCourseMembership(courses);
}

function buildCoursesMobile(pins, courses) {
    const box = qs("#m-courses");
    if (!pins.length) {
        box.innerHTML = `<div class="empty">코스가 없습니다</div>`;
        return;
    }
    const pinById = Object.fromEntries(pins.map(p => [p.id, p]));
    const html = (courses || []).map((c, idx) => {
        const color = COLORS[idx % COLORS.length];
        const ids = (Array.isArray(c.spots) && c.spots.length) ? c.spots : (c.route_order || []);
        const name = c.title || c.region || `코스 ${idx+1}`;
        const desc = (typeof c.distance_km === "number") ? `약 ${c.distance_km}km` : (c.itinerary || "");
        const li = ids.map((id, i) => {
            const p = pinById[id];
            if (!p) return "";
            return `<div class="item" data-id="${id}">
                <div class="label" style="background:${color}">${letter(i)}</div>
                <div><div class="title">${escapeHtml(p.title||"")}</div><div class="addr">${escapeHtml(p.subtitle||"")}</div></div>
            </div>`;
        }).join("");
        return `
        <section class="m-course" data-idx="${idx}">
          <div class="m-course-header" data-idx="${idx}" style="padding:10px;background:rgba(172,225,215,0.7);cursor:pointer">
            <div class="addr"><b>${name}</b> · ${desc}</div>
            <div style="display:flex;gap:6px;margin-top:6px;justify-content:flex-end">
              <button class="ghost" data-act="m-zoom" data-idx="${idx}">확대하기</button>
              <button class="ghost caret" data-act="m-expand" data-idx="${idx}" aria-expanded="false">펼치기 ▾</button>
            </div>
          </div>
          <div class="m-course-items" data-idx="${idx}" style="display:none">
            ${li || '<div class="empty">장소 없음</div>'}
          </div>
        </section>`;
    }).join("");
    box.innerHTML = html;

    if (openMobileCourseIdx != null) {
        const secs = box.querySelectorAll('section.m-course');
        const sec = secs[openMobileCourseIdx];
        if (sec) toggleMobileCoursePanel(sec, box);
    }

    box.onclick = (e) => {
        const btnZoom = e.target.closest('button[data-act="m-zoom"]');
        const btnExp = e.target.closest('button[data-act="m-expand"]');
        const header = e.target.closest('.m-course-header');
        const item = e.target.closest('.item[data-id]');

        if (btnZoom) {
            const idx = +btnZoom.dataset.idx;
            const c = courses[idx];
            const ids = ((Array.isArray(c.spots) && c.spots.length) ? c.spots : (c.route_order || [])).filter(id => idToLatLng[id]);
            if (!ids.length) return;
            const b = new kakao.maps.LatLngBounds();
            ids.forEach(id => b.extend(idToLatLng[id]));
            map.setBounds(b);
            ensureSheetHeight(0.62); // ← 고정 높이
            return;
        }
        if (btnExp || header) {
            const sec = (btnExp || header).closest('section.m-course');
            toggleMobileCoursePanel(sec, box);
            ensureSheetHeight(0.62); // ← 고정 높이
            return;
        }
        if (item) {
            selectPlace(item.dataset.id, {
                pan: true,
                ping: true,
                keepCourses: true
            });
            ensureSheetHeight(0.62); // ← 항목 눌러도 고정
            return;
        }
    };

    indexCourseMembership(courses);
}

function toggleCoursePanel(section, container) {
    const scope = container || document.getElementById('panel-courses');
    const targetList = section.querySelector('.course-items');
    const willOpen = getComputedStyle(targetList).display === 'none';
    scope.querySelectorAll('section.course').forEach(sec => {
        const list = sec.querySelector('.course-items');
        const btn = sec.querySelector('button[data-act="expand"]');
        const isMe = sec === section;
        list.style.display = (isMe && willOpen) ? 'block' : 'none';
        if (btn) {
            btn.setAttribute('aria-expanded', String(isMe && willOpen));
            btn.textContent = (isMe && willOpen) ? '접기 ▴' : '펼치기 ▾';
        }
    });
}

function toggleMobileCoursePanel(section, container) {
    const scope = container || document.getElementById('m-courses');
    const targetList = section.querySelector('.m-course-items');
    const willOpen = getComputedStyle(targetList).display === 'none';

    scope.querySelectorAll('section.m-course').forEach((sec, i) => {
        const list = sec.querySelector('.m-course-items');
        const btn = sec.querySelector('button[data-act="m-expand"]');
        const isMe = sec === section;
        list.style.display = (isMe && willOpen) ? 'block' : 'none';
        if (btn) {
            btn.setAttribute('aria-expanded', String(isMe && willOpen));
            btn.textContent = (isMe && willOpen) ? '접기 ▴' : '펼치기 ▾';
        }
        if (isMe && willOpen) openMobileCourseIdx = i; // ★ 추가
        if (isMe && !willOpen) openMobileCourseIdx = null; // ★ 추가
    });
    if (willOpen) ensureSheetHeight(0.62);
}

function indexCourseMembership(courses) {
    Object.keys(placeIdToCourseIdx).forEach(k => delete placeIdToCourseIdx[k]);
    courses.forEach((c, idx) => {
        const ids = (Array.isArray(c.spots) && c.spots.length) ? c.spots : (c.route_order || []);
        ids.forEach(id => {
            if (!(id in placeIdToCourseIdx)) placeIdToCourseIdx[id] = idx;
        });
    });
}

// 즐겨찾기 1개 삭제(공통)
async function deleteFavoriteById(id) {
    if (!auth?.user) { toast('로그인이 필요합니다'); return false; }

    let r;
    try {
        r = await reqJSON(`/api/user/favorites/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (e) {
        toast('삭제 실패: 잠시 후 다시 시도해주세요');
        return false;
    }
    if (!r?.ok) { toast('삭제 실패'); return false; }

    if (activePlaceId === id) {
        try { infoWin?.close(); } catch {}
        activePlaceId = null;
    }
    // 로컬 상태
    favSet.delete(id);
    window.myFavItems = (window.myFavItems || []).filter(x => x.id !== id);
    applyFavOrderLocally(window.myFavItems);

    // ★ [추가] 검색결과/목록의 별/삭제버튼 즉시 비활성화
    reflectFavoriteUI(id, false);

    // ★ [추가] 지도 마커도 즉시 제거(클러스터 포함)
    const mk = markerById[id];
    if (mk) {
        try { clusterer?.removeMarker?.(mk); } catch {}
        try { clusterer?.removeMarkers?.([mk]); } catch {}
        try { mk.setMap && mk.setMap(null); } catch {}
        delete markerById[id];
    }

    // 서버 상태 재동기화(안전망)
    await syncFavorites().catch(()=>{});
    if (document.querySelector('.tabs .tab.active')?.dataset.tab === 'mine') {
    updateMapByContext('mine');      // 지도 핀/경로 갱신
    }

    toast('보관함에서 삭제했습니다');
    return true;
}

function drawRoutesFromCourses(pins, courses) {
    polylines.forEach(l => l.setMap(null));
    polylines = [];
    if (!courses || !courses.length) return;
    const byId = {};
    pins.forEach(p => byId[p.id] = p);
    courses.forEach((c, idx) => {
        const path = [];
        ((Array.isArray(c.spots) && c.spots.length) ? c.spots : (c.route_order || [])).forEach(id => {
            const p = byId[id];
            if (p) path.push(new kakao.maps.LatLng(p.lat, p.lng));
        });
        if (path.length >= 2) {
            const line = new kakao.maps.Polyline({
                path,
                strokeWeight: 3,
                strokeColor: COLORS[idx % COLORS.length],
                strokeOpacity: 0.9,
                strokeStyle: 'solid'
            });
            line.setMap(map);
            polylines.push(line);
        }
    });
}

function showSavedCourseById(cid) {
    const courses = window.mySavedCourses || [];
    const course  = courses.find(c => String(c.id) === String(cid));
    if (!course) { toast('코스를 불러오지 못했어요'); return; }

    const pins = (course.spots || []).map((s, idx) => ({
        id: s.id || s.place_id || s.placeId || `course-${cid}-${idx}`,
        title: s.title || s.name || '',
        subtitle: s.addr || s.address || '',
        lat: +s.lat, lng: +s.lng
    })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));

    // 지도 갱신
    setMarkersForPins(pins, { fit: true });
    polylines.forEach(p => p.setMap(null)); polylines = [];
    drawRoutesFromCourses(pins, [{ spots: pins.map(p => p.id) }]);

    // ★ 여기 가드 추가: 내 보관함 탭이면 코스 패널은 갱신하지 않음
    const activeTab = document.querySelector('.tabs .tab.active')?.dataset.tab;
    if (activeTab !== 'mine') {
        try { renderSavedCourseToPanels(course, pins); } catch {}
    }

    toast((course.title || '코스') + ' 보기');
}

// [NEW] 코스에서 특정 스폿 제거 후 서버에 저장
// [REPLACE] 코스에서 특정 스폿 제거 (PUT 불가 → 새 코스 생성 후 구 코스 삭제로 치환)
// === [PATCH] 코스에서 특정 스폿 제거 (내 보관함에 머무는 옵션 추가) ===
// 코스에서 특정 스폿 제거 (새 코스 생성→구 코스 삭제 방식 유지)
// stayInMine: true 이면 '내 보관함'의 해당 섹션만 부분 갱신(펼침 유지)
async function removeSpotFromCourse(cid, spotId, { stayInMine = true } = {}) {
  if (window._courseReorderLock) return false;
  window._courseReorderLock = true;

  try {
    if (!auth?.user) { toast('로그인이 필요합니다'); return false; }

    const courses = window.mySavedCourses || [];
    const course  = courses.find(c => String(c.id) === String(cid));
    if (!course) { toast('코스를 찾지 못했습니다'); return false; }

    const normId = (s) => String(s.id || s.place_id || s.placeId);
    const newSpotsRaw = (course.spots || []).filter(s => normId(s) !== String(spotId));

    if (newSpotsRaw.length === 0) {
      // 마지막 하나면 코스 자체 삭제 여부 확인
      if (confirm('이 장소를 빼면 코스가 비게 됩니다. 코스를 삭제할까요?')) {
        return await deleteCourseById(cid);
      }
      return false;
    }

    const newSpots = newSpotsRaw.map(s => ({
      id:   s.id   || s.place_id || s.placeId,
      title: s.title || s.name || '',
      addr:  s.addr  || s.address || '',
      lat:   +s.lat,
      lng:   +s.lng
    }));

    const payload = {
      title: course.title || '내 코스',
      notes: course.notes || '',
      spots: newSpots
    };

    const created = await reqJSON('/api/user/courses', {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    if (!created?.ok) throw new Error('create_failed');

    const newCourse = created.course || { id: created.id, ...payload };
    try { await reqJSON(`/api/user/courses/${encodeURIComponent(cid)}`, { method: 'DELETE' }); } catch {}

    // 캐시 치환
    const idx = courses.findIndex(c => String(c.id) === String(cid));
    if (idx >= 0) courses[idx] = newCourse; else courses.unshift(newCourse);
    window.mySavedCourses = courses;

    if (stayInMine) {
      // === 내 보관함 패널의 해당 섹션만 부분 갱신, 펼침 유지 ===
      const mine = document.getElementById('panel-mine');
      const sec  = mine?.querySelector(`section.mine-course[data-cid="${cid}"]`) ||
                   mine?.querySelector(`section.course[data-cid="${cid}"]`);
      if (sec) {
        sec.setAttribute('data-cid', String(newCourse.id));
        const header = sec.querySelector('.course-header, .m-course-header');
        if (header) {
          const titleEl = header.querySelector('b');
          if (titleEl) titleEl.textContent = newCourse.title || '내 코스';
          const countEl = header.querySelector('.addr');
          if (countEl) countEl.textContent = `${newSpots.length}곳`;
        }
        const listEl = sec.querySelector('.course-items, .m-course-items');
        if (listEl) {
          listEl.innerHTML = newSpots.map((p, i) => `
            <div class="item" data-id="${p.id}">
              <div class="label">${i + 1}</div>
              <div>
                <div class="title">${escapeHtml(p.title||'')}</div>
                <div class="addr">${escapeHtml(p.addr||'')}</div>
                <div style="margin-top:6px;display:flex;gap:6px">
                  <button class="ghost btn-spot-del" data-id="${p.id}" type="button">삭제</button>
                </div>
              </div>
            </div>
          `).join('');
          listEl.style.display = 'block';
        }
      }
      window.mineExpandedId = String(newCourse.id); // 펼침 기억
      toast('코스에서 제거했습니다');
    } else {
      // 기존 동작 유지가 필요하면
      showSavedCourseById(newCourse.id);
    }

    return true;

  } catch (e) {
    console.error(e);
    toast('삭제 실패: 잠시 후 다시 시도해주세요');
    return false;

  } finally {
    window._courseReorderLock = false;
  }
}

function reorderCourseSpots(draggedIndex, targetIndex) {
    // 배열 범위 체크
    if (draggedIndex < 0 || draggedIndex >= window.mySavedCourses.length ||
        targetIndex < 0 || targetIndex >= window.mySavedCourses.length) {
        console.error('Invalid index range:', draggedIndex, targetIndex);
        return; // 유효하지 않은 인덱스 처리
    }

    const course = window.mySavedCourses[draggedIndex];

    // course가 유효한지 체크
    if (!course || typeof course !== 'object' || !course.id) {
        console.error(`Invalid course at index ${draggedIndex}:`, course);
        return; // 유효하지 않으면 종료
    }

    // 순서 변경
    window.mySavedCourses.splice(draggedIndex, 1);  // draggedIndex에서 항목 제거
    window.mySavedCourses.splice(targetIndex, 0, course);  // targetIndex에 항목 삽입

    // UI 업데이트
    renderCourses(window.mySavedCourses);
}

// [NEW] 저장된 코스 삭제(PC/모바일 공용)
async function deleteCourseById(cid) {
  if (!auth?.user) { toast('로그인이 필요합니다'); return false; }
  try {
    const r = await reqJSON(`/api/user/courses/${encodeURIComponent(cid)}`, { method: 'DELETE' });
    if (!r?.ok) throw new Error('fail');

    // 1) 메모리에 있는 목록에서도 지우기
    window.mySavedCourses = (window.mySavedCourses || []).filter(c => String(c.id) !== String(cid));

    // 2) 펼침 상태 초기화 (삭제된 코스가 더 이상 존재하지 않으니까)
    window.mineExpandedId = null; // ← 이걸로 교체

    // 3) 왼쪽 "내 코스" 리스트 다시 그리기
    await loadMyBox();

    // 4) 사용자에게 알림
    toast('코스를 삭제했습니다');

    // 5) 현재 코스 패널/경로도 초기화 (이미 코드에 있었던 부분 그대로 유지)
    try { polylines.forEach(p=>p.setMap(null)); polylines = []; } catch {}
    const pc = document.getElementById('panel-courses');
    if (pc) pc.innerHTML = `<div class="empty">코스를 선택하면 표시됩니다</div>`;
    const mo = document.getElementById('m-courses');
    if (mo) mo.innerHTML = `<div class="empty">코스를 선택하면 표시됩니다</div>`;

    return true;
  } catch (e) {
    console.error(e);
    toast('삭제 실패: 잠시 후 다시 시도해주세요');
    return false;
  }
}


// [NEW] 저장된 코스 → PC/모바일 패널에 리스트로 렌더링
function renderSavedCourseToPanels(course, pins) {
  // 1) PC 좌측 코스 패널
  const pc = document.getElementById('panel-courses');
  if (pc) {
    const li = (pins||[]).map((p,i)=>`
      <div class="item" data-id="${p.id}">
        <div class="label">${i+1}</div>
        <div>
          <div class="title">${escapeHtml(p.title||'')}</div>
          <div class="addr">${escapeHtml(p.subtitle||'')}</div>
          <div style="margin-top:6px;display:flex;gap:6px">
            <button class="ghost btn-spot-del" data-id="${p.id}" type="button">삭제</button>
          </div>
        </div>
      </div>`).join('');
    pc.innerHTML = `
      <section class="course saved" data-cid="${course.id}">
        <div class="course-header" style="padding:10px;background:rgba(172,225,215,0.7)">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            <div><b>${escapeHtml(course.title||'내 코스')}</b> 
              <span class="addr" style="opacity:.8">${pins.length}곳</span>
            </div>
            <div>
              <button class="ghost" data-act="zoom">확대하기</button>
              <button class="ghost danger" data-act="delete">삭제</button>
            </div>
          </div>
        </div>
        <div class="course-items" style="display:block">
          ${li || '<div class="empty">장소 없음</div>'}
        </div>
      </section>`;

    // 클릭 위임: 항목 선택/확대
    pc.onclick = (e) => {
      const delSpot = e.target.closest('.btn-spot-del');
      if (delSpot) {
        const sid = delSpot.dataset.id || delSpot.closest('.item')?.dataset.id;
        if (sid && confirm('이 장소를 코스에서 삭제할까요?')) removeSpotFromCourse(course.id, sid);
        return;
      }
      const z = e.target.closest('button[data-act="zoom"]');
      if (z && pins.length) {
        const b = new kakao.maps.LatLngBounds();
        pins.forEach(p=>b.extend(new kakao.maps.LatLng(p.lat,p.lng)));
        map.setBounds(b);
        return;
      }
      const it = e.target.closest('.item[data-id]');
      if (it) selectPlace(it.dataset.id, { pan:true, ping:true });
    };

    // 데스크톱: 좌측 탭을 '코스'로 전환
    try {
      const cur = document.querySelector('.tabs .tab.active');
      const tgt = document.querySelector('.tabs .tab[data-tab="courses"]');
      if (tgt && cur !== tgt) {
        cur?.classList.remove('active'); cur?.setAttribute('aria-selected','false');
        tgt.classList.add('active');      tgt.setAttribute('aria-selected','true');
        ['results','mine','courses'].forEach(k=>{
          const el = document.getElementById(`panel-${k}`);
          if (el) el.style.display = (k==='courses')?'block':'none';
        });
      }
    } catch {}
  }

  // 2) 모바일 하단 시트의 코스 탭
  const mo = document.getElementById('m-courses');
  if (mo) {
    const li = (pins||[]).map((p,i)=>`
      <div class="item" data-id="${p.id}">
        <div class="label">${i+1}</div>
        <div>
          <div class="title">${escapeHtml(p.title||'')}</div>
          <div class="addr">${escapeHtml(p.subtitle||'')}</div>
          <div style="margin-top:6px;display:flex;gap:6px">
            <button class="ghost btn-spot-del" data-id="${p.id}" type="button">삭제</button>
          </div>
        </div>
      </div>`).join('');
    mo.innerHTML = `
      <section class="m-course saved" data-cid="${course.id}">
        <div class="m-course-header" style="padding:10px;background:rgba(172,225,215,0.7)">
          <div class="addr"><b>${escapeHtml(course.title||'내 코스')}</b> · ${pins.length}곳</div>
          <div style="display:flex;gap:6px;margin-top:6px;justify-content:flex-end">
            <button class="ghost" data-act="m-zoom">확대하기</button>
            <button class="ghost danger" data-act="m-delete">삭제</button>
          </div>
        </div>
        <div class="m-course-items" style="display:block">
          ${li || '<div class="empty">장소 없음</div>'}
        </div>
      </section>`;

    // 모바일 클릭 위임
    mo.onclick = (e) => {
      const delSpot = e.target.closest('.btn-spot-del');
      if (delSpot) {
        const sid = delSpot.dataset.id || delSpot.closest('.item')?.dataset.id;
        if (sid && confirm('이 장소를 코스에서 삭제할까요?')) {
          removeSpotFromCourse(course.id, sid);
          ensureSheetHeight(0.62);
        }
        return;
      }
      const z = e.target.closest('button[data-act="m-zoom"]');
      if (z && pins.length) {
        const b = new kakao.maps.LatLngBounds();
        pins.forEach(p=>b.extend(new kakao.maps.LatLng(p.lat,p.lng)));
        map.setBounds(b);
        ensureSheetHeight(0.62);
        return;
      }
      const it = e.target.closest('.item[data-id]');
      if (it) {
        selectPlace(it.dataset.id, { pan:true, ping:true, keepCourses:true });
        ensureSheetHeight(0.62);
      }
    };

    // 모바일: 시트 탭을 'courses'로 전환 + 높이 고정
    try {
      const cur = document.querySelector('.sheet-tabs .sheet-tab.active');
      const tgt = document.querySelector('.sheet-tabs .sheet-tab[data-stab="courses"]');
      if (tgt && cur !== tgt) { cur?.classList.remove('active'); tgt.classList.add('active'); }
      ['results','courses','mine'].forEach(k=>{
        const el = document.getElementById(`m-${k}`);
        if (el) el.style.display = (k==='courses')?'block':'none';
      });
      ensureSheetHeight(0.62);
    } catch {}
  }
}



function render(data) {
    last = data;
    renderWorkCard(data.meta);
    qs("#emptyCard")?.style && (qs("#emptyCard").style.display = (data && data.pins && data.pins.length) ? 'none' : 'block');
    clearMap();

    const pins = data.pins || [];
    const courses = Array.isArray(data.courses) ? data.courses : [];

    // ===== Place(장소) 모드라면: 먼저 작품 그룹을 보여주고, 지도를 전체 추천 핀으로 맞춤
    if (typeof isPlaceModeData === 'function' && isPlaceModeData(data)) {
        PLACE_GROUPS = groupPinsByWork(pins);
        PLACE_GROUP_ACTIVE = null;

        typeof renderPlaceGroups_PC === 'function' && renderPlaceGroups_PC(PLACE_GROUPS);
        typeof renderPlaceGroups_Mobile === 'function' && renderPlaceGroups_Mobile(PLACE_GROUPS);


        // 지도는 전체 추천 핀으로 맞춤
        setMarkersForPins(pins, {
            fit: true
        });

        // 코스 패널은 안내문 정도만
        document.getElementById('panel-courses').innerHTML = `<div class="empty">작품을 선택하면 해당 촬영지가 표시됩니다</div>`;
        document.getElementById('m-courses').innerHTML = `<div class="empty">작품을 선택하면 해당 촬영지가 표시됩니다</div>`;

        return; // ★ 기본 렌더(작품/배우) 로직으로 내려가지 않도록 반드시 종료
    }
    window.last = data;
    window.pinsById = Object.fromEntries(pins.map(p => [p.id, p]));

    const toClusterer = [];
    const bounds = new kakao.maps.LatLngBounds();
    idToLatLng = {};
    pins.forEach(p => {
        if (typeof p.lat === "number" && typeof p.lng === "number") {
            idToLatLng[p.id] = new kakao.maps.LatLng(p.lat, p.lng);
        }
    });
    // ② 코스 라인 준비(필요할 때 보여줌)
    polylines.forEach(l => l.setMap(null));
    polylines = [];
    // drawRoutesFromCourses(pins, courses);
    // ③ 현재 활성 탭 기준으로 지도 갱신
    updateMapByContext(document.querySelector('.tabs .tab.active')?.dataset.tab || 'results');

    // 리스트들
    buildResultsPins(pins);
    buildCourses(pins, courses);
    buildResultsMobilePins(pins);
    buildCoursesMobile(pins, courses);
}

/* =========================
 * 상세보기 패널
 * ========================= */
const PD = {
    el: null,
    open(place, coords) {
        PD.el.classList.add('open');
        PD.el.setAttribute('aria-hidden', 'false');
        requestAnimationFrame(() => renderPlaceDetail(place, coords));
    },
    close() {
        PD.el.classList.remove('open');
        PD.el.setAttribute('aria-hidden', 'true');
    }
};

function initPlaceDetail() {
    PD.el = document.getElementById('place-detail');
    PD.el?.querySelector('.pd-back')?.addEventListener('click', PD.close);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && PD.el?.classList.contains('open')) PD.close();
    });
    PD.el?.addEventListener('click', (e) => {
        if (e.target === PD.el) PD.close();
    });
}
initPlaceDetail();

function getPlaceById(id) {
    const p = (last?.pins || []).find(x => x.id === id);
    if (p) return p;
    return (window.pinsById && window.pinsById[id]) ? window.pinsById[id] : null;
}

// 펼쳐진 상태 유지: 이미 열려있으면 아무 것도 하지 않고, 닫혀있을 때만 연다
function openCourseSection(section, container) {
  const scope = container || document.getElementById('panel-courses');
  const targetList = section.querySelector('.course-items');
  if (!targetList) return;

  const isClosed = getComputedStyle(targetList).display === 'none';
  if (isClosed) {
    // 닫혀있을 때만 토글 호출 → 결과적으로 '열림' 상태가 됨
    toggleCoursePanel(section, scope);
  } else {
    // 이미 열려 있으면 표시/접기 상태를 유지하면서 보조 UI만 동기화
    const btn = section.querySelector('button[data-act="expand"]');
    if (btn) {
      btn.setAttribute('aria-expanded', 'true');
      btn.textContent = '접기 ▴';
    }
  }
}

function openMobileCourseSection(section, container) {
    toggleMobileCoursePanel(section, container);
}

function selectPlace(placeId, options = {}) {
    const {
        pan = true, ping = false, keepCourses = false
    } = options;
    const pcCourses = document.getElementById('panel-courses');
    const pcResults = document.getElementById('panel-results');
    const pcMine = document.getElementById('panel-mine');
    const moCourses = document.getElementById('m-courses');
    const moResults = document.getElementById('m-results');
    const sideActive = document.querySelector('.tabs .tab.active')?.dataset.tab;
    // const sheetActive = document.querySelector('.sheet-tabs .sheet-tab.active')?.dataset.stab;
    let sheetActive = document.querySelector('.sheet-tabs .sheet-tab.active')?.dataset.stab;
    // === [PATCH] Mobile: keep current context; if 'mine' is active, stay in 'mine' ===
    // === [PATCH] Mobile: keep current sheet tab; highlight within that tab ===
    if (MOBILE_Q.matches) {
    try {
        const nowActive = document.querySelector('.sheet-tabs .sheet-tab.active')?.dataset.stab;
        // 컨텍스트 우선순위: mine 유지 > 코스 옵션/탭 > 기본(results)
        let preferred = 'results';
        if (nowActive === 'mine') preferred = 'mine';
        else if (options?.keepCourses || nowActive === 'courses') preferred = 'courses';

        // 탭 활성화/보이기
        const cur = document.querySelector('.sheet-tabs .sheet-tab.active');
        const tgt = document.querySelector(`.sheet-tabs .sheet-tab[data-stab="${preferred}"]`);
        if (tgt && cur !== tgt) {
        cur?.classList.remove('active');
        tgt.classList.add('active');
        }
        // 시트 내부 컨텐트 스위칭
        ['results','courses','mine'].forEach(k => {
        const el = document.getElementById(`m-${k}`);
        if (el) el.style.display = (k === preferred) ? 'block' : 'none';
        });

        // 시트 펼침/높이 고정
        if (typeof ensureMobileSheetOpen === 'function') {
            ensureMobileSheetOpen(preferred);
        }
        if (typeof openSheetToPercent === 'function') ensureSheetHeight(0.62);

        // ✅ 아래 분기들이 옛 sheetActive로 오판하지 않게 현재 탭으로 갱신
        sheetActive = preferred;

        // ✅ 리스트 하이라이트 + 스크롤 (컨텍스트별 선택자 차이 주의)
        if (preferred === 'mine') {
        // 내 보관함 리스트는 data-fid 사용
        const moMine = document.getElementById('m-mine');
        if (moMine) {
            moMine.querySelectorAll('.item.active').forEach(el => el.classList.remove('active'));
            const it = moMine.querySelector(`.item[data-fid="${placeId}"]`);
            if (it) {
            it.classList.add('active');
            it.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
        } else if (preferred === 'courses') {
        // 코스는 기존 분기(아래 쪽)에서 섹션 오픈/하이라이트가 처리됨
        /* no-op */
        } else {
        // results
        const moResultsNow = document.getElementById('m-results');
        if (moResultsNow) {
            moResultsNow.querySelectorAll('.item.active').forEach(el => el.classList.remove('active'));
            const it = moResultsNow.querySelector(`.item[data-id="${placeId}"]`);
            if (it) {
            it.classList.add('active');
            it.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
        }
        }
    } catch (e) { /* no-op */ }
    }

    const ci = placeIdToCourseIdx[placeId];

    if (sideActive === 'courses' && pcCourses && Number.isInteger(ci)) {
        const sec = pcCourses.querySelector(`section.course[data-idx="${ci}"]`);
        if (sec) {
            openCourseSection(sec, pcCourses);
            pcCourses.querySelectorAll('.item.active').forEach(el => el.classList.remove('active'));
            const it = sec.querySelector(`.course-items .item[data-id="${placeId}"]`);
            if (it) {
                it.classList.add('active');
                it.scrollIntoView({
                    behavior: 'smooth',
                    block: 'center'
                });
            }
        }
    } else if (sideActive === 'results' && pcResults) {
        pcResults.querySelectorAll('.item.active').forEach(el => el.classList.remove('active'));
        const it = pcResults.querySelector(`.item[data-id="${placeId}"]`);
        if (it) {
            it.classList.add('active');
            it.scrollIntoView({
                behavior: 'smooth',
                block: 'center'
            });
        }
    }
    if (sheetActive === 'courses' && moCourses && Number.isInteger(ci)) {
        const sec = moCourses.querySelector(`section.m-course[data-idx="${ci}"]`);
        if (sec) {
            openMobileCourseSection(sec, moCourses);
            moCourses.querySelectorAll('.item.active').forEach(el => el.classList.remove('active'));
            const it = sec.querySelector(`.m-course-items .item[data-id="${placeId}"]`);
            if (it) {
                it.classList.add('active');
            }
        }
    } else if (sheetActive === 'results' && moResults) {
        moResults.querySelectorAll('.item.active').forEach(el => el.classList.remove('active'));
        const it = moResults.querySelector(`.item[data-id="${placeId}"]`);
        if (it) {
            it.classList.add('active');
            // 리스트 가운데로 스크롤
            it.scrollIntoView({
                behavior: 'smooth',
                block: 'center'
            });
            // 시트 위로 펼치기 + 탭 보정
            ensureMobileSheetOpen('results');
        }
    }
    // ➜ 내 보관함 동기화(사이드 패널)
    if (sideActive === 'mine' && pcMine) {
        pcMine.querySelectorAll('.item.active').forEach(el => el.classList.remove('active'));
        const it = pcMine.querySelector(`.item[data-fid="${placeId}"]`);
        if (it) {
            it.classList.add('active');
            it.scrollIntoView({
                behavior: 'smooth',
                block: 'center'
            });
        }
    }
    const marker = markerById[placeId];
    if (marker) {
        if (pan) map.panTo(marker.getPosition());
        highlightMarker(marker);
        if (ping) pingOverlay(marker.getPosition());
    } else {
        const ll = idToLatLng[placeId];
        if (pan && ll) map.panTo(ll);
    }

    if (MOBILE_Q.matches) {
        // 리스트가 화면을 많이 가리고 있을 수 있으니 자동으로 내려줌 (55% 지점)
        map.setLevel(Math.max(1, map.getLevel() - 1));
        openSheetToPercent(0.62); // ← 0.55 = 위쪽에서 55% 위치(= 시트가 45%만 보이게)
    }
    // 말풍선(InfoWindow)을 리스트 클릭만으로도 열어주기
    let place = getPlaceById(placeId);
    // ✅ last.pins에 없을 수 있는 '보관함' 아이템은 로컬 보관함으로 대체
    if (!place && sheetActive === 'mine') {
        const fav = (window.myFavItems || []).find(x => x.id === placeId);
        if (fav) {
            place = { id: fav.id, title: fav.title, subtitle: fav.addr, lat: +fav.lat, lng: +fav.lng };
        }
    }
    if (!place && sideActive === 'mine') {
        const fav = (window.myFavItems || []).find(x => x.id === placeId);
        if (fav) {
            place = { id: fav.id, title: fav.title, subtitle: fav.addr, lat: +fav.lat, lng: +fav.lng };
        }
    }
    const pos = marker ? marker.getPosition()
        : (idToLatLng[placeId] || (place && Number.isFinite(place.lat) && Number.isFinite(place.lng)
            ? new kakao.maps.LatLng(place.lat, place.lng) : null));

    // --- [FOCUS PATCH] 내 보관함 컨텍스트일 때는 선택 지점을 확실히 중앙/확대 ---
    (function focusWhenMine() {
    // sheetActive가 let으로 선언되어 있고, 모바일 분기에서 preferred로 갱신되어 있어야 함
    // (이미 이전 패치에서 적용하셨다면 그대로 동작)
    const isMine =
        (typeof sheetActive !== 'undefined' && sheetActive === 'mine') || // 모바일 시트
        (document.querySelector('.tabs .tab.active')?.dataset.tab === 'mine'); // 데스크톱 좌측 탭
    if (!isMine) return;

    // marker 또는 좌표(pos)가 있어야 한다
    const pos = marker ? marker.getPosition() : idToLatLng[placeId];
    if (!pos) return;
    // 이미 위에서 계산된 pos(보관함 fallback 포함)를 그대로 사용
    const focusPos =
      (marker && marker.getPosition && marker.getPosition()) ||
      idToLatLng[placeId] ||
      (place && Number.isFinite(place.lat) && Number.isFinite(place.lng)
        ? new kakao.maps.LatLng(place.lat, place.lng)
        : null);
    if (!focusPos) return;
    // 1) 앵커 줌: 너무 멀리 있으면 원하는 레벨까지 부드럽게 당겨옴
    //    (Kakao 지도는 숫자가 작을수록 더 확대됩니다)
    const TARGET = 3; // 3~5 사이 추천. 필요시 3으로 더 강하게 확대
    if (map.getLevel() > TARGET) {
      map.setLevel(TARGET, { anchor: focusPos });
    }
    // 2) 센터 이동(앵커 줌 후에도 미세하게 빗나가는 걸 보정)
    map.panTo(focusPos);

    // --- PC 전용: 좌측 패널 가림 보정으로 실제 보이는 중앙에 배치 ---
    if (!MOBILE_Q.matches) {
    const activeLeft =
        document.querySelector('#panel-courses:not([style*="display: none"])') ||
        document.querySelector('#panel-results:not([style*="display: none"])') ||
        document.querySelector('#panel-mine:not([style*="display: none"])');
        const _onceIdle = () => {
            try {
                const dx = panBiasForLeftUI(activeLeft ? '#' + activeLeft.id : '#panel-results', 16);
                if (dx) map.panBy(dx, 0);
            } finally {
                // Kakao Maps는 removeListener 지원
                kakao.maps.event.removeListener(map, 'idle', _onceIdle);
            }
        };
        kakao.maps.event.addListener(map, 'idle', _onceIdle);
    }

    // 3) 핑/하이라이트(옵션)
    highlightMarker?.(marker);
    if (typeof pingOverlay === 'function') pingOverlay(focusPos);
    })();


    if (place && pos) {
        const title = escapeHtml(place.title || "");
        const sub = escapeHtml(place.subtitle || "");
        const html = `<div style="padding:6px 8px">
                      <b>${title}</b>
                      <div style="color:#9fb9e8;font-size:12px">${sub}</div>
                    </div>`;
        infoWin.setContent(html);

        if (marker) {
            infoWin.open(map, marker); // 마커가 있으면 마커에 붙여서
        } else {
            infoWin.setPosition(pos); // 없으면 좌표에 직접 표시
            infoWin.open(map);
        }
    }
    if (place?.id && typeof highlightListItem === 'function') highlightListItem(place.id);
    activePlaceId = placeId;
}

function selectTourItem(id, { ping = true, pan = true } = {}) {
    const mk = tourMarkerById[id];
    const it = tourItemsById[id];
    if (!mk && !it) return;

    const pos = mk ? mk.getPosition() : new kakao.maps.LatLng(+it.lat, +it.lng);

    // ① 리스트 하이라이트(PC/모바일 모두)
    ['#panel-results', '#m-results'].forEach(sel => {
    const box = document.querySelector(sel);
    if (!box) return;
    box.querySelectorAll('.item.active').forEach(n => n.classList.remove('active'));
    const row = box.querySelector(`.item[data-fid="${id}"]`);
    if (row) {
        row.classList.add('active');
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    });

  // ② 지도 이동/확대(클러스터 해제 레벨)
    // ② 지도 이동/확대(클러스터 해제 레벨)
    if (map.getLevel() > 3) map.setLevel(1, { anchor: pos });
    if (pan) map.panTo(pos);

    // ✅ 좌측 패널 가림 보정(데스크톱): panTo가 끝난 뒤 한 번만 적용 + 같은 아이템 연속 클릭시 스킵
    if (!MOBILE_Q.matches) {
    const dx = panBiasForLeftUI('#panel-results', 16);
    const sameItem = (__lastTourItemId === id);
    __lastTourItemId = id;

    if (dx && !sameItem) {
        kakao.maps.event.addListenerOnce(map, 'idle', () => {
        // 이미 보정돼 있으면 생략(안전장치)
        try {
            const proj = map.getProjection();
            const cenPt = proj.containerPointFromCoords(map.getCenter());
            const posPt = proj.containerPointFromCoords(pos);
            const alreadyBiased = Math.abs((cenPt.x - posPt.x) - dx) < 2;
            if (!alreadyBiased) map.panBy(dx, 0);
        } catch (_) {
            map.panBy(dx, 0);
        }
        });
    }
    } else {
    try { openSheetToPercent?.(0.62); } catch {}
    }

    // ③ 하이라이트 & 핑
    if (mk) highlightMarker(mk);
    if (ping) pingOverlay(pos);

    // ④ 인포윈도우
    const title = escapeHtml((it?.title) || '');
    const addr  = escapeHtml((it?.addr)  || '');
    infoWin.setContent(
        `<div style="padding:6px 8px">
        <b>${title}</b>
        <div style="color:#9fb9e8;font-size:12px">${addr}</div>
        </div>`
    );
    if (mk) infoWin.open(map, mk); else { infoWin.setPosition(pos); infoWin.open(map); }
}

function renderPlaceDetail(place, coords) {
    if (!place) return;
    const title = place.title || place.name || '촬영지';
    const addr = place.subtitle || place.addr || '';
    document.getElementById('pd-title').textContent = title;
    document.getElementById('pd-addr').textContent = addr;

    loadYouTubeForPlace(place);
    loadRoadviewForPlace(place);
    loadGoogleForPlace(place);
    loadTourApiForPlace(place);
}

function openPlaceDetailById(placeId, coords) {
    const place = getPlaceById(placeId);
    if (!place) return;
    PD.open(place, coords);
}

// 결과 리스트의 상세보기 버튼 위임(PC/모바일)
const _pr = document.getElementById('panel-results');
_pr && _pr.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-detail');
    if (!btn) return;
    const host = btn.closest('.item');
    const id = host?.getAttribute('data-id') || btn.dataset.id;
    if (!id) return;
    const lat = parseFloat(host?.dataset.lat);
    const lng = parseFloat(host?.dataset.lng);
    openPlaceDetailById(id, {
        lat: Number.isFinite(lat) ? lat : null,
        lng: Number.isFinite(lng) ? lng : null
    });
});
const _mr = document.getElementById('m-results');
_mr && _mr.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-detail');
    if (!btn) return;
    const id = btn.closest('.item')?.getAttribute('data-id') || btn.dataset.id;
    if (id) openPlaceDetailById(id);
});

/* =========================
 * Kakao Roadview mini
 * ========================= */
function loadRoadviewForPlace(place, coords) {
    const box = document.getElementById('pd-roadmap');
    if (!box) return;

    // 1) 좌표 먼저 확정
    const pLat = (coords?.lat ?? place?.lat ?? idToLatLng[place?.id]?.getLat?.());
    const pLng = (coords?.lng ?? place?.lng ?? idToLatLng[place?.id]?.getLng?.());
    if (typeof pLat !== 'number' || typeof pLng !== 'number') {
        box.innerHTML = `<div class="ghost-line" style="width:100%">좌표 정보가 없어 지도를 표시할 수 없습니다</div>`;
        return;
    }
    const ll = new kakao.maps.LatLng(pLat, pLng);

    // 2) UI 렌더
    box.classList.remove('placeholder');
    box.innerHTML = `
      <div class="rd-wrap">
        <div id="pd-map-mini" style="position:absolute; inset:0; display:none;"></div>
        <div id="pd-rv-mini"  style="position:absolute; inset:0;"></div>
        <div class="rd-controls">
          <button type="button" data-act="map">지도</button>
          <button type="button" data-act="roadview">로드뷰</button>
          <button type="button" data-act="route">길찾기</button>
        </div>
      </div>`;

    // 3) 지도/로드뷰 생성
    const mapEl = document.getElementById('pd-map-mini');
    const rvEl = document.getElementById('pd-rv-mini');

    let mapMini = null;
    if (mapEl) {
        mapMini = new kakao.maps.Map(mapEl, {
            center: ll,
            level: 3
        });
        setTimeout(() => mapMini.relayout(), 0);
        new kakao.maps.Marker({
            position: ll,
            map: mapMini,
            title: place?.title || place?.name || ''
        });
    }

    let roadview = null;
    if (rvEl) {
        roadview = new kakao.maps.Roadview(rvEl);
        const rvClient = new kakao.maps.RoadviewClient();
        rvClient.getNearestPanoId(ll, 100, function(panoId) {
            if (!panoId) {
                rvEl.innerHTML = '<div class="ghost-line" style="width:100%">이 위치 근처에 로드뷰가 없습니다</div>';
                if (mapEl) mapEl.style.display = 'block';
                return;
            }
            roadview.setPanoId(panoId, ll);
            roadview.setViewpoint({
                pan: -30,
                tilt: 0,
                zoom: 0
            });
            setTimeout(() => roadview.relayout(), 0);
        });
    }

    const title = place?.title || place?.name || '촬영지';
    const btnMap = box.querySelector('button[data-act="map"]');
    const btnRv = box.querySelector('button[data-act="roadview"]');
    const btnRt = box.querySelector('button[data-act="route"]');

    btnMap.onclick = () => {
        rvEl.style.display = 'none';
        mapEl.style.display = 'block';
        setTimeout(() => mapMini?.relayout(), 0);
    };
    btnRv.onclick = () => {
        mapEl.style.display = 'none';
        rvEl.style.display = 'block';
        setTimeout(() => roadview?.relayout(), 0);
    };
    btnRt.onclick = () => {
        window.open(`https://map.kakao.com/link/to/${encodeURIComponent(title)},${pLat},${pLng}`, '_blank', 'noopener');
    };

    // 상세 상단 CTA도 좌표 사용
    const {
        lat: placeLat,
        lng: placeLng
    } = place || {};
    document.getElementById('ctaRoute')?.addEventListener('click', () =>  {
        if (typeof placeLat === 'number' && typeof placeLng === 'number') {
            window.open(`https://map.kakao.com/link/to/${encodeURIComponent(place.title||'촬영지')},${placeLat},${placeLng}`, '_blank');
        }
    });
        // 1) 담기(코스 담기 모드면 코스에 추가, 아니면 즐겨찾기 토글)
    document.getElementById('ctaAdd')?.addEventListener('click', async () => {
        if (!auth?.user) { toast('로그인이 필요합니다'); return; }

        // 좌표/타이틀 확보
        const title = place?.title || place?.name || '촬영지';
        const addr  = place?.subtitle || place?.addr || '';
        const lat   = +((place?.lat ?? coords?.lat) ?? NaN);
        const lng   = +((place?.lng ?? coords?.lng) ?? NaN);

        // ID가 없으면 좌표 기반 임시 ID 생성
        const id = place?.id || makeTourSpotIdFromData(title, addr, lat, lng);

        // 코스 담기 모드가 켜져 있으면 코스에 추가
        if (courseDraft) {
            if (!courseDraft.spots.find(s => s.id === id)) {
            courseDraft.spots.push({ id, title, addr, lat, lng });
            toast('코스에 담겼어요');
            } else {
            toast('이미 코스에 담긴 장소예요');
            }
            return;
        }

        // 아니면 즐겨찾기 토글
        const add = !favSet.has(id);
        const ok = await upsertFavorite({ id, title, addr, lat, lng }, add);
        if (ok) toast(add ? '즐겨찾기에 추가했어요' : '즐겨찾기에서 제거했어요');
    });
    // 2) 공유(웹쉐어 지원 시 공유, 미지원 시 링크 복사)
    document.getElementById('ctaShare')?.addEventListener('click', async () => {
        const title = place?.title || place?.name || '촬영지';
        const pLat  = +((place?.lat ?? coords?.lat) ?? NaN);
        const pLng  = +((place?.lng ?? coords?.lng) ?? NaN);

        // 좌표가 있으면 카카오맵 링크, 없으면 현재 페이지 URL
        const shareUrl = (Number.isFinite(pLat) && Number.isFinite(pLng))
            ? `https://map.kakao.com/link/map/${encodeURIComponent(title)},${pLat},${pLng}`
            : location.href;

        try {
            if (navigator.share) {
            await navigator.share({ title: `${title} 촬영지`, text: `${title} 촬영지 공유`, url: shareUrl });
            return;
            }
        } catch (_) { /* 사용자가 공유 취소해도 무시 */ }

        try {
            await navigator.clipboard.writeText(shareUrl);
            toast('링크를 클립보드에 복사했어요');
        } catch {
            // iOS 사파리 등 클립보드 실패 대비
            prompt('아래 링크를 복사해 주세요', shareUrl);
        }
    });
}

/* =========================
 * Google Programmable Search (링크 카드)
 * ========================= */
// 교체: Google Programmable Search (프록시 우선)

async function gcsSearch(query, { num = 10, start = 1 } = {}) {
    try {
        const url = API_BASE.replace(/\/$/, "") + "/api/gcs?" + new URLSearchParams({
            q: query,
            num: String(num),
            start: String(start),
            lr: "lang_ko",
            safe: "active"
        });
        const r = await fetch(url, {
            credentials: "include",
            headers: { "Accept": "application/json" }
        });
        const j = await r.json();
        return { items: j.items || [], q: query };
    } catch (e) {
        console.warn("Google proxy error:", e);
        return { items: [], q: query };
    }
}

const RE_FILMING = /(촬영\s*지|촬영\s*장소)/;
const korIncludes = (s, kw) => (s || "").toLowerCase().includes((kw || "").toLowerCase());

function filterGoogleItems(items, baseKeyword) {
    return (items || []).filter(it => {
        const hay = [it.title, it.snippet].join(" ");
        return RE_FILMING.test(hay) && korIncludes(hay, baseKeyword);
    });
}

function thumbFromItem(it) {
    const pm = it.pagemap || {};
    const th = (pm.cse_thumbnail && pm.cse_thumbnail[0]?.src) || (pm.cse_image && pm.cse_image[0]?.src) || "";
    return th;
}

function renderGoogleCards(items, qUsed) {
    const grid = document.getElementById("pd-google");
    if (!grid) return;
    if (!items.length) {
        grid.innerHTML = `<div class="pd-card"><div class="ghost-line" style="width:100%">조건에 맞는 결과가 없습니다</div></div>`;
    } else {
        grid.innerHTML = items.slice(0, 4).map(it => {
            const url = it.link;
            const host = (() => {
                try {
                    return new URL(url).hostname.replace(/^www\./, '');
                } catch {
                    return ""
                }
            })();
            const th = thumbFromItem(it);
            const title = escapeHtml(it.title || "");
            return `
          <a class="pd-card" href="${url}" target="_blank" rel="noopener" style="display:block;overflow:hidden;padding:0;text-decoration:none;color:inherit">
            ${ th ? `<img src="${th}" alt="" style="width:100%;height:140px;object-fit:cover;display:block">` : "" }
            <div style="padding:10px">
              <div style="font-weight:700;line-height:1.35">${title}</div>
              <div style="font-size:12px;opacity:.75;margin-top:4px">${host}</div>
            </div>
          </a>`;
        }).join("");
    }
    const btn = document.querySelector(`.pd-more[data-sec="google"]`);
    if (btn) {
        btn.textContent = "Google에서 더 보기 ↗";
        btn.title = `Google에서 '${qUsed}' 검색`;
        btn.onclick = (e) => {
            e.preventDefault();
            window.open(`https://www.google.com/search?q=${encodeURIComponent(qUsed)}`, "_blank", "noopener");
        };
    }
}

async function loadGoogleForPlace(place) {
    const base = (LAST_KEYWORD || "").trim();
    if (!base) {
        renderGoogleCards([], "");
        return;
    }
    const placeKw = (place?.title || place?.name || "").trim();
    const queries = placeKw ?
        [`${base} 촬영지 ${placeKw}`, `${base} 촬영장소 ${placeKw}`, `${base} 촬영지`, `${base} 촬영장소`] :
        [`${base} 촬영지`, `${base} 촬영장소`];

    let got = [],
        used = "";
    for (const q of queries) {
        try {
            const {
                items
            } = await gcsSearch(q, {
                num: 10
            });
            const filtered = filterGoogleItems(items, base);
            if (filtered.length) {
                got = filtered;
                used = q;
                break;
            }
        } catch (e) {
            console.warn("Google CSE fail:", e);
        }
    }
    renderGoogleCards(got, used || queries[0] || `${base} 촬영지`);
}

/* =========================
 * TourAPI (서버 프록시: /api/tour/nearby)
 * ========================= */
async function tourNearby(lat, lng, {
    radius = 2000,
    type = "all",
    max = 24
} = {}) {
    const url = API_BASE + "/api/tour/nearby?" + new URLSearchParams({
        lat,
        lng,
        radius,
        type,
        max
    });
    const r = await fetch(url);
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "TourAPI proxy error");
    return j.items || [];
}

function renderTourGrid(container, items) {
    if (!container) return;

    if (!items.length) {
        container.innerHTML = `<div class="pd-card placeholder"><div class="ghost-line">결과 없음</div></div>`;
        return;
    }

    // 컨테이너 id로 타입 추정 (tour / hotel / food)
    const vtype = container.id.includes('hotel') ? 'hotel' :
        container.id.includes('food') ? 'food' :
        'tour';

    container.innerHTML = items.map(it => {
        const id = makeTourSpotIdFromData(it.title, it.addr, it.lat, it.lng);
        const star = favSet?.has?.(id) ? '★' : '☆';
        const tTitle = escapeHtml(it.title || "");
        const tAddr = escapeHtml(it.addr || "");

        // ▶ 썸네일 결정: 있으면 사용, 없으면 플레이스홀더
        const imgSrc = it.thumb && it.thumb.trim() ?
            it.thumb :
            makePlaceholderThumb(it.title || '', vtype);

        return `
        <div class="pd-card tour-card"
            data-fid="${id}"
            data-tlat="${it.lat}" data-tlng="${it.lng}"
            data-ttitle="${tTitle}" data-taddr="${tAddr}"
            title="${tTitle}">
          <div class="thumb">
            <img src="${imgSrc}" alt="">
          </div>
          <div class="info">
            <div class="title">${tTitle}</div>
            <div class="addr">${tAddr}</div>
            <div class="actions">
              <button class="btn-fav"       type="button">${star}</button>
              <button class="btn-to-course" type="button">➕ 코스담기</button>
            </div>
          </div>
        </div>
      `;
    }).join("");

    // (기존과 동일) 버튼 위임
    container.onclick = (e) => {
        const host = e.target.closest('.pd-card.tour-card');
        if (!host) return;
        const lat = +host.dataset.tlat;
        const lng = +host.dataset.tlng;
        const title = decodeHtml(host.dataset.ttitle || host.querySelector('.title')?.textContent || '');
        const addr = decodeHtml(host.dataset.taddr || host.querySelector('.addr')?.textContent || '');
        const id = host.dataset.fid || makeTourSpotIdFromData(title, addr, lat, lng);

        const favBtn = e.target.closest('.btn-fav');
        if (favBtn) {
            toggleFavoriteTour({
                id,
                title,
                addr,
                lat,
                lng
            }, favBtn);
            return;
        }

        const addBtn = e.target.closest('.btn-to-course');
        if (addBtn) {
            addTourItemToCourse({
                id,
                title,
                addr,
                lat,
                lng
            });
            return;
        }
    };
}

function bindTourMoreButton(secName, label, items) {
    const btn = document.querySelector(`.pd-more[data-sec="${secName}"]`);
    if (!btn) return;
    btn.textContent = "자세히 보기";
    btn.onclick = (e) => {
        e.preventDefault();
        showTourListAndMap(label, items);
        toast(`관광공사 ${label} 표시`);
        document.getElementById("place-detail")?.classList.remove("open");
    };
}
let tourMarkers = [];
let tourItemsById  = {};  
let tourMarkerById = {}; 
let __lastTourItemId = null;

function clearTourLayer() {
  if (clusterer && tourMarkers.length) clusterer.removeMarkers(tourMarkers);
  tourMarkers.forEach(m => m.setMap && m.setMap(null));
  tourMarkers = [];
  Object.keys(tourMarkerById).forEach(k => delete tourMarkerById[k]);
  tourItemsById = {};
  try { infoWin.close(); } catch {}
}
// 2) showTourListAndMap() 내 헤더/이벤트 부분 교체
function showTourListAndMap(label, items) {
    const boxPC = document.getElementById("panel-results");
    const boxM = document.getElementById("m-results");

    const html = items.map((p, i) => {
        const id = makeTourSpotIdFromData(p.title, p.addr, p.lat, p.lng);
        const star = favSet?.has?.(id) ? '★' : '☆';
        return `
        <div class="item" data-tidx="${i}" data-fid="${id}" data-lat="${p.lat}" data-lng="${p.lng}">
          <div class="label">${i + 1}</div>
          <div>
            <div class="title">${escapeHtml(p.title || "")}</div>
            <div class="addr">${escapeHtml(p.addr || "")}</div>
            ${typeof p.dist_km === "number" ? `<div class="meta">약 ${p.dist_km}km</div>` : ""}
            <div style="margin-top:6px;display:flex;gap:6px">
              <button class="btn-fav ghost"       type="button">${star}</button>
              <button class="btn-to-course ghost" type="button">➕ 코스담기</button>
            </div>
          </div>
        </div>
      `;
    }).join("");

    // ߑ頉D 대신 class 사용 (중복 ID 방지)
    const header = `
      <div style="display:flex;gap:8px;align-items:center;padding:10px;
                  border-bottom:1px solid #1f2b3f;background:#0c152a">
        <button class="ghost tourBack">← 드라마로 돌아가기</button>
        <b style="margin-left:6px">관광공사 ${label} 전체 목록</b>
      </div>`;

    boxPC.innerHTML = header + html;
    boxM.innerHTML = header + html;

    // ߑ頭圠번만 동작하는 {once:true} 제거, 위임으로 일관 처리
    [boxPC, boxM].forEach(box => {
        box.onclick = (e) => {
            // ← 돌아가기
            if (e.target.closest(".tourBack")) {
                e.preventDefault();
                clearTourLayer();
                popResultsState();
                toast("이전 결과로 돌아왔습니다");
                return;
            }

            // ★ 즐겨찾기
            const favBtn = e.target.closest(".btn-fav");
            if (favBtn) {
                const host = favBtn.closest(".item[data-tidx]");
                if (!host) return;
                const idx = +host.dataset.tidx;
                const it = items[idx];
                const id = host.dataset.fid || makeTourSpotIdFromData(it.title, it.addr, it.lat, it.lng);
                toggleFavoriteTour({
                    id,
                    title: decodeHtml(it.title),
                    addr: decodeHtml(it.addr),
                    lat: it.lat,
                    lng: it.lng
                }, favBtn);
                return;
            }

            // ➕ 코스담기
            const addBtn = e.target.closest(".btn-to-course");
            if (addBtn) {
                const host = addBtn.closest(".item[data-tidx]");
                if (!host) return;
                const idx = +host.dataset.tidx;
                const it = items[idx];
                const id = host.dataset.fid || makeTourSpotIdFromData(it.title, it.addr, it.lat, it.lng);
                addTourItemToCourse({
                    id,
                    title: it.title,
                    addr: it.addr,
                    lat: it.lat,
                    lng: it.lng
                });
                return;
            }

            // 리스트 클릭 → 지도 이동
            const itRow = e.target.closest(".item[data-fid]");
            if (itRow) {
            selectTourItem(itRow.dataset.fid);
            return;
            }
        };
    });


    // 지도 마커/바운즈 세팅
    clearTourLayer();
    const bounds = new kakao.maps.LatLngBounds();
    items.forEach(p => {
        const id = makeTourSpotIdFromData(p.title, p.addr, p.lat, p.lng);
        tourItemsById[id] = { title: p.title, addr: p.addr, lat: p.lat, lng: p.lng };

        const ll = new kakao.maps.LatLng(p.lat, p.lng);
        const mk = new kakao.maps.Marker({ position: ll, title: p.title || "" });

        tourMarkerById[id] = mk;
        tourMarkers.push(mk);
        bounds.extend(ll);

        kakao.maps.event.addListener(mk, 'click', () => selectTourItem(id));
    });

    clusterer.addMarkers(tourMarkers);
    if (!bounds.isEmpty()) map.setBounds(bounds);


    // ߓᠫꨫԬ 상단 ‘← 돌아가기’ 버튼도 활성화
    const dockBtn = document.getElementById("backFromTour");
    if (dockBtn) {
    dockBtn.style.display = "inline-block";
        dockBtn.onclick = (e) => {
            e.preventDefault();
            clearTourLayer();
            popResultsState();
            toast("이전 결과로 돌아왔습니다");
        };
    }
}

async function loadTourApiForPlace(place) {
    const {
        lat,
        lng
    } = place || {};
    const wrapA = document.getElementById("pd-tour-attraction");
    const wrapH = document.getElementById("pd-tour-hotel");
    const wrapF = document.getElementById("pd-tour-food");
    if (!wrapA || !wrapH || !wrapF || typeof lat !== "number" || typeof lng !== "number") return;

    const loading = `<div class="pd-card placeholder"><div class="ghost-line">불러오는 중…</div></div>`;
    wrapA.innerHTML = loading;
    wrapH.innerHTML = loading;
    wrapF.innerHTML = loading;

    try {
        const [attractions, hotels, foods] = await Promise.all([
            tourNearby(lat, lng, {
                radius: 3000,
                type: "12",
                max: 24
            }),
            tourNearby(lat, lng, {
                radius: 3000,
                type: "32",
                max: 24
            }),
            tourNearby(lat, lng, {
                radius: 3000,
                type: "39",
                max: 24
            })
        ]);
        renderTourGrid(wrapA, attractions.slice(0, 4));
        renderTourGrid(wrapH, hotels.slice(0, 4));
        renderTourGrid(wrapF, foods.slice(0, 4));
        bindTourMoreButton("tourapi-attraction", "명소", attractions);
        bindTourMoreButton("tourapi-hotel", "숙박", hotels);
        bindTourMoreButton("tourapi-food", "음식", foods);
    } catch (e) {
        console.warn("TourAPI preview fail:", e);
        const fail = `<div class="pd-card placeholder"><div class="ghost-line">결과 없음</div></div>`;
        wrapA.innerHTML = fail;
        wrapH.innerHTML = fail;
        wrapF.innerHTML = fail;
    }
}

/* =========================
 * YouTube 섹션
 * ========================= */
let YT_API_READY = null,
    PD_YT_PLAYER = null;

function ensureYTAPI() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (YT_API_READY) return YT_API_READY;
    YT_API_READY = new Promise((resolve) => {
        const tag = document.createElement("script");
        tag.src = "https://www.youtube.com/iframe_api";
        document.head.appendChild(tag);
        window.onYouTubeIframeAPIReady = () => resolve();
    });
    return YT_API_READY;
}

async function mountYTPlayer(containerId, videoId, title) {
    const box = document.getElementById(containerId);
    if (!box) return;
    await ensureYTAPI();
    box.innerHTML = `<div id="pd-yt-player-frame" style="width:100%;height:100%"></div>`;
    PD_YT_PLAYER = new YT.Player("pd-yt-player-frame", {
        videoId,
        playerVars: {
            rel: 0,
            modestbranding: 1
        },
        events: {
            onError: (e) => {
                if (e?.data === 101 || e?.data === 150) {
                    const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
                    box.innerHTML = `
              <div style="display:grid;place-items:center;height:100%;padding:10px;text-align:center">
                <div style="max-width:520px">
                  <img src="${ytThumb(videoId)}" alt="" style="width:100%;border-radius:8px;display:block"/>
                  <div style="margin:10px 0 12px;font-weight:700">${(title||"").replace(/</g,"&lt;")}</div>
                  <div style="opacity:.8;margin-bottom:10px">이 영상은 외부 사이트에서 재생할 수 없습니다.</div>
                  <a href="${watchUrl}" target="_blank" rel="noopener" style="display:inline-block;padding:8px 12px;border-radius:10px;border:1px solid #2a3d62;background:#0b1a33;color:#cfe1ff;text-decoration:none">YouTube에서 보기 ↗</a>
                </div>
              </div>`;
                }
            }
        }
    });
}

async function fetchYouTubeFromServer(q, max = 4) {
    const url = API_BASE.replace(/\/$/, "") + "/api/youtube?" + new URLSearchParams({
        q,
        max
    });
    const r = await fetch(url, {
        headers: {
            "Accept": "application/json"
        }
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || "youtube_api_fail");
    return j.items || [];
}

async function loadYouTubeForPlace() {
    const hero = document.getElementById("pd-youtube");
    if (!hero) return;
    hero.classList.remove("placeholder");
    hero.innerHTML = `<div class="ghost-line">YouTube 불러오는 중…</div>`;
    const base = (LAST_KEYWORD ? `${LAST_KEYWORD} 티저 예고편` : "").trim();
    if (!base) {
        hero.innerHTML = `<div class="ghost-line">검색어가 없습니다</div>`;
        return;
    }

    let items = [];
    try {
        items = await fetchYouTubeFromServer(base, 4);
    } catch (e) {
        console.warn("YouTube fetch fail:", e);
        items = [];
    }

    if (!items.length) {
        hero.innerHTML = `
        <iframe width="100%" height="100%"
          src="https://www.youtube-nocookie.com/embed?listType=search&list=${encodeURIComponent(base)}&rel=0&modestbranding=1"
          frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
    } else {
        const first = items[0];
        hero.innerHTML = `
        <div id="pd-yt-hero" style="position:relative;width:100%;height:100%">
          <img src="${first.thumb || ytThumb(first.id)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:8px"/>
          <button id="pd-yt-play" type="button"
            style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);padding:12px 18px;border-radius:999px;border:0;background:#ffffffd9;color:#111;font-weight:700;cursor:pointer">
            ▶ 재생
          </button>
        </div>`;
        document.getElementById("pd-yt-play")?.addEventListener("click", () => {
            mountYTPlayer("pd-youtube", first.id, first.title);
        });

        let list = document.getElementById("pd-youtube-list");
        if (!list) {
            list = document.createElement("div");
            list.id = "pd-youtube-list";
            list.style.cssText = "display:grid; margin-top:10px; gap:8px; grid-template-columns: repeat(4, 1fr);";
            hero.parentElement.appendChild(list);
        }
        list.innerHTML = items.slice(0, 8).map(v => `
        <div class="pd-card" data-vid="${v.id}" title="${(v.title||"").replace(/"/g,'&quot;')}" style="padding:0;overflow:hidden;cursor:pointer">
          <img src="${v.thumb || ytThumb(v.id)}" alt="" style="width:100%;height:100%;object-fit:cover"/>
        </div>`).join("");

        list.onclick = (e) => {
            const card = e.target.closest(".pd-card[data-vid]");
            if (!card) return;
            const vid = card.getAttribute("data-vid");
            const v = items.find(x => x.id === vid);
            mountYTPlayer("pd-youtube", vid, v?.title || "");
        };
    }

    const moreBtn = document.querySelector(".pd-more[data-sec='youtube']");
    if (moreBtn) {
        moreBtn.textContent = "유튜브에서 더 보기 ↗";
        moreBtn.title = `YouTube에서 '${base}' 검색`;
        moreBtn.onclick = (e) => {
            e.preventDefault();
            window.open("https://www.youtube.com/results?search_query=" + encodeURIComponent(base), "_blank", "noopener");
        };
    }
}

/* =========================
 * Search / Actions
 * ========================= */
async function reqJSON(path, opts = {}) {
    const r = await fetch(API_BASE + path, {
        credentials: 'include', // ← 중요
        headers: {
            "Content-Type": "application/json",
            ...(opts.headers || {})
        },
        ...opts
    });
    const text = await r.text();
    // if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0,200)}`);
    if (!r.ok) {
        // 인증 필요 API가 로그인 전이면 조용히 no-op
        if (r.status === 401 && /\/api\/auth\/me|\/api\/user\/favorites/.test(path)) {
            return {
                ok: false,
                unauthorized: true
            };
        }
        throw new Error(`HTTP ${r.status}: ${text.slice(0,200)}`);
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`Invalid JSON: ${text.slice(0,200)}`);
    }
}

async function fetchDramaMeta(title, kind) {
    try {
        const r = await fetch(API_BASE + "/api/dramaMeta?" + new URLSearchParams({
            title,
            kind
        }));
        const j = await r.json();
        return j.ok ? j : null;
    } catch (e) {
        console.error(e);
        return null;
    }
}

async function searchWork(title, kind, opts = {
    willUpdate: false
}) {
    LAST_KEYWORD = title || LAST_KEYWORD;
    const willUpdate = !!opts.willUpdate;

    // 장소 모드면 좌표 선확보
    if (kind === 'place') {
        const got = await resolvePlaceLL(title);
        if (!got || !Number.isFinite(got.lat) || !Number.isFinite(got.lng)) {
            toast('장소 좌표를 찾지 못했습니다');
            return;
        }
        window.__lastPlaceLL = {
            lat: got.lat,
            lng: got.lng
        };
        // 서버에는 보여줄 키워드도 정리된 이름으로 보내면 UX가 좋아요
        title = got.name || title;
    }

    const btn = qs("#go"),
        label = qs("#goLabel");
    if (btn && label) {
        btn.disabled = true;
        label.textContent = willUpdate ? "업데이트 중…" : "불러오는 중…";
        loadingOn();
    }

    try {
        const body = {
            mode: (kind === "place" ? "place" : "work"),
            keyword: title,
            query: "",
            want_itinerary: true,
            refresh: willUpdate,
            kind
        };

        if (kind === "place" && window.__lastPlaceLL) {
            body.lat = window.__lastPlaceLL.lat;
            body.lng = window.__lastPlaceLL.lng;
        }

        const data = await reqJSON("/api/chat", {
            method: "POST",
            body: JSON.stringify(body)
        });

        if (data.pins_empty) {
            qs("#panel-results").innerHTML = `<div class="empty">촬영지를 찾지 못했습니다 ${willUpdate ? "(업데이트는 완료됨)" : ""}</div>`;
            qs("#m-results").innerHTML = `<div class="empty">촬영지를 찾지 못했습니다 ${willUpdate ? "(업데이트는 완료됨)" : ""}</div>`;
            toast("촬영지 없음");
            return;
        }

        render(data);
        toast(willUpdate ? "업데이트 완료" : "완료");
        syncFavorites().catch(() => {});

        const meta = await fetchDramaMeta(title, kind || "drama");
        if (meta) {
            last.meta = meta; // 모바일 내장 카드에 사용
            showMetaCard(meta); // PC 결과 패널 상단 카드 유지
            buildResultsMobilePins(last.pins || []); // 모바일 리스트 갱신(메타 반영)
        }
        return data;

    } catch (e) {
        console.error(e);
        toast("실패");
    } finally {
        if (btn && label) {
            btn.disabled = false;
            label.textContent = "검색";
            loadingOff();
        }
    }
}

async function searchActor(name) {
    // 데스크톱/모바일 버튼 모두 잠그기
    const btns = [qs("#go"), qs("#mGo")].filter(Boolean);
    const labels = [qs("#goLabel"), qs("#mGoLabel")].filter(Boolean);
    btns.forEach(b => b.disabled = true);
    labels.forEach(l => l.textContent = "불러오는 중…");
    loadingOn();

    try {
        const data = await reqJSON("/api/actor?" + new URLSearchParams({
            name
        }));
        renderWorksList(data.items || [], name);
    } catch (e) {
        console.error(e);
        toast("3분 뒤 재검색 하시면 됩니다.");
    } finally {
        btns.forEach(b => b.disabled = false);
        labels.forEach(l => l.textContent = "검색");
        loadingOff(); // ← 이게 핵심!
    }
}

function renderWorksList(items, actorName) {
    renderWorkCard(null);
    const box = qs("#panel-results");

    if (!items?.length) {
        box.innerHTML = `<div class="empty">"${actorName}"의 드라마 목록이 없습니다</div>`;
        return;
    }

    box.innerHTML = items.map((w, i) => {
        const kindFromServer = (w.media_type || '').includes('영화') ? 'movie' : null;
        const kind = kindFromServer || detectKindFromWork(w);
        const kindLabel = kind === 'film' ? '영화' : '드라마';
        const kindBadge = `<span class="badge-kind ${kind==='film'?'is-movie':'is-tv'}">${kindLabel}</span>`;
        const yearText = w.year ? `${w.year}년` : '';

        return `
        <div class="item" data-title="${escapeHtml(w.title || '')}">
          <div class="label">${i + 1}</div>
          <div>
            <div class="title">${escapeHtml(w.title || "")}</div>
            <div class="addr">
              ${yearText}${yearText ? ' ' : ''}${kindBadge}
              ${w.network ? ` · ${escapeHtml(w.network)}` : ''} ${w.role ? ` · ${escapeHtml(w.role)}` : ''}
            </div>
            <div class="meta">클릭하면 촬영지/코스를 불러옵니다 (출처:나무위키)</div>
          </div>
        </div>`;
    }).join("");

    // 클릭 핸들러 그대로 유지
    box.onclick = (e) => {
        const it = e.target.closest('.item[data-title]');
        if (!it) return;
        searchWork(it.getAttribute('data-title'));
    };

    // 모바일 리스트도 동일하게 복사
    const mbox = qs("#m-results");
    mbox.innerHTML = box.innerHTML;
    mbox.onclick = (e) => {
        const it = e.target.closest('.item[data-title]');
        if (!it) return;
        searchWork(it.getAttribute('data-title'));
    };

    clearMap();
    qs("#panel-courses").innerHTML = `<div class="empty">작품을 선택하면 코스가 표시됩니다</div>`;
    qs("#m-courses").innerHTML = `<div class="empty">작품을 선택하면 코스가 표시됩니다</div>`;
    qs("#legend")?.style && (qs("#legend").style.display = 'none');
    qs("#emptyCard")?.style && (qs("#emptyCard").style.display = 'none');
    toast("작품을 선택하세요");
}

async function runSearch(mode, keyword) {
    if (!keyword) {
        toast("키워드를 입력하세요");
        return;
    }
    console.log(mode, keyword);
    if (mode === "actor") {
        return searchActor(keyword);
    } else if (mode === "place") {
        if (typeof searchPlaceByKeyword === "function") return searchPlaceByKeyword(keyword, 1);
        if (typeof searchPlace === "function") return searchPlace(keyword);
        toast("장소 검색 모듈이 로드되지 않았습니다");
        return;
    } else {
        return searchWork(keyword, mode);
    }
}

// 1) 결과 복구 함수 추가 (렌더로 되돌리기)
function popResultsState() {
    try {
        if (last) render(last);
        else {
            qs("#panel-results").innerHTML = `<div class="empty">검색 결과가 없습니다</div>`;
            qs("#m-results").innerHTML = ``;
        }
    } finally {
        const dockBtn = document.getElementById("backFromTour");
        if (dockBtn) dockBtn.style.display = "none";
    }
    syncFavorites().catch(() => {});
}

// 공통: 진행배지 제목 계산
function calcRefreshTitle(mode, willUpdate, kw) {
    return (mode === "actor" || mode === "place" || !willUpdate) ? null : kw;
}

// 데스크톱 버튼
on('go','click', () => {
    dismissKeyboard();
    const mode = qs("#mode").value;
    const kw = qs("#keyword").value.trim();
    const willUpdate = !!qs("#doRefresh")?.checked;
    if (!kw) {
        toast("키워드를 입력하세요");
        return;
    }
    LAST_KEYWORD = kw;
    CURRENT_REFRESH_TITLE = calcRefreshTitle(mode, willUpdate, kw);

    loadingOn();
    if (mode === "actor") {
        searchActor(kw);
    } else if (mode === "place") {
        // 둘 중 프로젝트에 있는 함수로 사용
        if (typeof searchPlaceByKeyword === "function") {
            searchPlaceByKeyword(kw, 1); // 반경 5km

        } else {
            searchPlace(kw); // 대체 구현
        }
    } else {
        searchWork(kw, mode, {
            willUpdate
        });
    }
});
// 모바일 버튼
on('mGo','click', () => {
    dismissKeyboard();
    const mode = qs("#mMode").value;
    const kw = qs("#mKeyword").value.trim();
    const willUpdate = !!qs("#mDoRefresh")?.checked;
    if (!kw) {
        toast("키워드를 입력하세요");
        return;
    }
    LAST_KEYWORD = kw;
    CURRENT_REFRESH_TITLE = calcRefreshTitle(mode, willUpdate, kw);

    loadingOn();
    if (mode === "actor") {
        searchActor(kw);
    } else if (mode === "place") {
        if (typeof searchPlaceByKeyword === "function") {
            searchPlaceByKeyword(kw, 5);
        } else {
            searchPlace(kw);
        }
    } else {
        searchWork(kw, mode, {
            willUpdate
        });
    }
});

// 엔터키 제출: PC/모바일 모두 해당 버튼 클릭으로 위임
function bindEnterSubmit(inputSel, clickSel) {
    const input = qs(inputSel);
    const btn = qs(clickSel);
    if (!input || !btn) return;
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            btn.click();
        }
    });
}

bindEnterSubmit("#keyword", "#go");
bindEnterSubmit("#mKeyword", "#mGo");
// 인라인 모바일 검색 UI를 쓰는 경우 아래 두 줄도 활성화
bindEnterSubmit("#mKeywordInline", "#mGoInline");

function toggleUpdateOption(selectEl, cbEl) {
    const isActorOrPlace = (selectEl.value === "actor" || selectEl.value === "place");
    if (cbEl) {
        cbEl.disabled = isActorOrPlace;
        if (isActorOrPlace) cbEl.checked = false;
    }
}

/* =========================
 * login/logout
 * ========================= */
//로그인
const auth = {
    user: null,
    async me() {
        try {
            const j = await reqJSON('/api/auth/me');
            if (j.ok) this.user = j.user;
        } catch {}
        return this.user;
    },
    async login(u, p) {
        const j = await reqJSON('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({
                username: u,
                password: p
            })
        });
        if (j.ok) {
            this.user = j.user;
        }
        return j;
    },
    async signup(u, p) {
        const j = await reqJSON('/api/auth/signup', {
            method: 'POST',
            body: JSON.stringify({
                username: u,
                password: p
            })
        });
        if (j.ok) {
            this.user = j.user;
        }
        return j;
    },
    async logout() {
        await reqJSON('/api/auth/logout', {
            method: 'POST'
        });
        this.user = null;
    }
};

let favSet = new Set();

async function syncFavorites() {
    try {
        const j = await reqJSON('/api/user/favorites');
        favSet = new Set((j.items || []).map(x => x.id));
        document.querySelectorAll('#panel-results .item, #m-results .item').forEach(it => {
            const id = it.getAttribute('data-id');
            const star = it.querySelector('.btn-fav');
            if (star) star.textContent = favSet.has(id) ? '★' : '☆';
            const rm = it.querySelector('.btn-remove');
            if (rm) rm.style.display = favSet.has(id) ? 'inline-flex' : 'none';
        });
    } catch {}
    // TourAPI 카드/목록의 ★ 갱신 (data-fid 사용)
    document.querySelectorAll('[data-fid] .btn-fav').forEach(btn => {
        const host = btn.closest('[data-fid]');
        const id = host?.dataset?.fid;
        if (id) btn.textContent = favSet.has(id) ? '★' : '☆';
    });
}

auth.me().then(async () => {
  setAuthUI();
  await syncFavorites();
  await loadMyBox(); // ★ 추가
});

function setAuthUI() {
    const name = auth?.user?.username;
    const pcs = document.querySelectorAll('#btnLogin');
    const mos = document.querySelectorAll('#mLogin, #mLoginInline');

    pcs.forEach(el => el.textContent = name ? `${name} 로그아웃` : '로그인');
    mos.forEach(el => el.textContent = name ? `${name} 로그아웃` : '로그인');
}

on('btnLogin','click', async () => {
    if (auth.user) {
        await auth.logout();
        setAuthUI();
        resetToInitialView();
        toast('로그아웃 됐어요');
        return;
    }
    qs('#authModal').style.display = 'block';
});
on('authClose','click', () => qs('#authModal').style.display = 'none');
on('doLogin','click', async () =>  {
    const u = qs('#authUser').value.trim(),
        p = qs('#authPass').value;
    const r = await auth.login(u, p);
    if (r.ok) {
        qs('#authModal').style.display = 'none';
        setAuthUI();
        toast('로그인 완료');
        loadMyBox();
    } else toast('아이디/비밀번호 확인');
});
on('doSignup','click', async () => {
    const u = qs('#authUser').value.trim(),
        p = qs('#authPass').value;
    const r = await auth.signup(u, p);
    if (r.ok) {
        qs('#authModal').style.display = 'none';
        setAuthUI();
        toast('가입+로그인 완료');
        loadMyBox();
    } else toast(r.error === 'username_taken' ? '이미 존재하는 아이디' : '가입 실패');
});

//로그아웃
function resetToInitialView() {
    // --- 상태값 초기화 ---
    LAST_KEYWORD = "";
    last = null;
    activePlaceId = null;
    window.pinsById = {};
    window.myFavItems = [];
    CURRENT_REFRESH_TITLE = null;

    // 코스 담기 모드 종료
    if (typeof courseDraft !== 'undefined' && courseDraft) {
        courseDraft = null;
        try {
            document.getElementById('fabTrip')?.classList?.remove('active');
        } catch {}
    }

    // 미리보기 라인/경로/오버레이 정리
    try {
        if (mineRoutePreview) {
            mineRoutePreview.setMap(null);
            mineRoutePreview = null;
        }
    } catch {}
    try {
        clearTourLayer?.();
    } catch {}
    try {
        polylines.forEach(p => p.setMap(null));
        polylines = [];
        clearMap();
    } catch {}

    // 지도 리셋(서울 시청 근처 + 기본 레벨)
    try {
        const center = new kakao.maps.LatLng(37.5665, 126.9780);
        map.setMapTypeId(kakao.maps.MapTypeId.ROADMAP);
        map.setCenter(center);
        map.setLevel(8);
    } catch {}

    // 패널/카드/입력창 리셋
    const setHTML = (sel, html) => {
        const el = document.querySelector(sel);
        if (el) el.innerHTML = html;
    };
    setHTML('#panel-results', '');
    setHTML('#panel-courses', '');
    setHTML('#m-results', '');
    setHTML('#m-courses', '');
    setHTML('#panel-mine', '<div class="empty">로그인하면 즐겨찾기/내 코스를 볼 수 있어요</div>');

    const wc = document.querySelector('#workCard');
    if (wc) {
        wc.style.display = 'none';
        wc.innerHTML = '';
    }
    try {
        PD?.close?.();
    } catch {}

    const kw = document.querySelector('#keyword');
    if (kw) kw.value = '';
    const mkw = document.querySelector('#mKeyword');
    if (mkw) mkw.value = '';

    // 탭/시트 가시성 초기화
    document.querySelectorAll('.tab').forEach(t => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
    });
    const tabResults = document.querySelector('.tabs .tab[data-tab="results"]');
    if (tabResults) {
        tabResults.classList.add('active');
        tabResults.setAttribute('aria-selected', 'true');
    }
    ['results', 'courses', 'mine'].forEach(name => {
        const p = document.querySelector(`#panel-${name}`);
        if (p) p.style.display = (name === 'results') ? 'block' : 'none';
    });

    document.querySelectorAll('.sheet-tab').forEach(t => t.classList.remove('active'));
    document.querySelector('.sheet-tab[data-stab="results"]')?.classList.add('active');
    const mRes = document.querySelector('#m-results');
    if (mRes) mRes.style.display = 'block';
    const mCrs = document.querySelector('#m-courses');
    if (mCrs) mCrs.style.display = 'none';

    // 모바일 시트 위치/부가 버튼들
    try {
        if (MOBILE_Q.matches) {
            openSheetTo(collapsedTop());
        }
    } catch {}
    const backBtn = document.querySelector('#backFromTour');
    if (backBtn) backBtn.style.display = 'none';
    const legend = document.querySelector('#legend');
    if (legend) legend.style.display = 'none';

    // 빈 카드 보이기
    const empty = document.querySelector('#emptyCard');
    if (empty) empty.style.display = 'block';
}

/* =========================
 * 즐겨찾기
 * ========================= */

// --- TourAPI → 즐겨찾기 토글 유틸 ---
async function toggleFavoriteTour({ id, title, addr, lat, lng }, starEl) {
    if (!auth?.user) { toast('로그인이 필요합니다'); return; }
    const wasFav = favSet.has(id);
    const url = '/api/user/favorites' + (wasFav ? `/${encodeURIComponent(id)}` : '');
    const opts = wasFav
        ? { method: 'DELETE' }
        : { method: 'POST', body: JSON.stringify({ id, title, addr, lat, lng }) };
    const r = await reqJSON(url, opts);
    if (!r?.ok) return;
    // 로컬 상태 갱신
    if (wasFav) favSet.delete(id); else favSet.add(id);
    if (starEl) starEl.textContent = favSet.has(id) ? '★' : '☆';
    reflectFavoriteUI(id, favSet.has(id));
    // UI 동기화
    await syncFavorites().catch(() => {});
    await loadMyBox().catch(() => {});
    toast(wasFav ? '즐겨찾기 해제' : '즐겨찾기 추가');
}

// async function toggleFavoriteTour(item, btn) {
//         if (!auth?.user) {
//             toast('로그인이 필요합니다');
//             return;
//         }
//         const willAdd = !favSet.has(item.id);
//         const ok = await upsertFavorite(item, willAdd);
//         if (ok) {
//             willAdd ? favSet.add(item.id) : favSet.delete(item.id);
//             if (btn) btn.textContent = willAdd ? '★' : '☆';
//         }
// }

(function bindFab() {
    const fab = document.getElementById('fabTrip');
    if (!fab) return;
    fab.onclick = () => {
        if (!auth?.user) {
            toast('로그인이 필요합니다');
            return;
        }
        if (courseDraft) {
            courseDraft = null;
            fab.classList.remove('active');
            toast('코스 담기 종료');
        } else {
            courseDraft = {
                title: '내 코스',
                spots: []
            };
            fab.classList.add('active');
            toast('지도에서 장소를 추가하세요');
        }
    };
})();


// 즐겨찾기
async function loadMyBox() {
    if (!auth.user) {
    qs('#panel-mine').innerHTML = `<div class="empty">로그인하면 즐겨찾기/내 코스를 볼 수 있어요</div>`;
    const mBox = document.getElementById('m-mine');
    if (mBox) mBox.innerHTML = `<div class="empty">로그인하면 즐겨찾기/내 코스를 볼 수 있어요</div>`;
    return;
    }
    const [fav, courses] = await Promise.allSettled([
        reqJSON('/api/user/favorites'),
        reqJSON('/api/user/courses'),
    ]);
    let favItems = fav.value?.items || [];
    // (1) ID 기준 중복 제거
    const uniq = new Map();
    favItems.forEach(x => {
        if (x?.id) uniq.set(x.id, x);
    });
    favItems = Array.from(uniq.values());
    // (2) 로컬 정렬 적용
    applyFavOrderLocally(favItems);
    // (3) 캐시 반영
    window.myFavItems = favItems;
    // (4) 별표/세트 최신화
    // 모바일 보관함 채우기
    if (typeof renderMobileMine === 'function') renderMobileMine();
        await syncFavorites().catch(() => {});
        const courseItems = courses.value?.items || [];
        window.mySavedCourses = courseItems; // ← 추가: 보관함 코스 전역 저장
    const favHtml = favItems.length ? favItems.map((r, i) => `
        <div class="item" data-fid="${r.id}" data-lat="${r.lat}" data-lng="${r.lng}" tabindex="0" role="button">
        <div class="dnd-handle" draggable="true" title="드래그로 순서 바꾸기">↕</div>
        <div class="label">${i+1}</div>
        <div>
            <div class="title">${escapeHtml(r.title||'')}</div>
            <div class="addr">${escapeHtml(r.addr||'')}</div>
            <div class="meta">위도 ${(+r.lat).toFixed(5)} / 경도 ${(+r.lng).toFixed(5)}</div>
            <button class="ghost btn-fav-del" type="button">삭제</button>
        </div>
        </div>`).join("") : `<div class="empty">즐겨찾기가 비어있어요</div>`;

    const courseHtml = (Array.isArray(courses) && courses.length)
        ? courses.map(c => `
            <section class="course" data-cid="${c.id}">
            <div class="course-header" style="padding:10px;border-bottom:1px solid #1f2b3f;background:rgba(172,225,215,0.7)">
                <div style="display:flex;justify-content:space-between;align-items:center">
                <div><b>${escapeHtml(c.title||'내 코스')}</b>
                    <span class="addr" style="opacity:.8">${(c.spots||[]).length}곳</span></div>
                <div>
                    <button class="ghost" data-act="expand" aria-expanded="false" data-id="${c.id}">보기 ▾</button>
                    <button class="btn-course-remove" data-id="${c.id}">삭제</button>
                </div>
                </div>
            </div>
            <!-- ↓↓↓ 펼쳐질 영역(초기에 숨김) -->
            <div class="course-items" style="display:none"></div>
            </section>
        `).join("")
        : `<div class="empty">저장한 코스가 없어요</div>`;



    qs('#panel-mine').innerHTML = `
        <div style="padding:8px 10px;color:#9fb9e8">즐겨찾기</div>
        <div id="favList">
            ${
            favItems.length
                ? favItems.map((r,i)=>`
                <div class="item" data-fid="${r.id}" data-lat="${r.lat}" data-lng="${r.lng}" tabindex="0" role="button">
                    <!-- ✅ 드래그 핸들: 이 한 줄이 꼭 있어야 합니다 -->
                    <div class="dnd-handle" draggable="true" title="드래그로 순서 바꾸기">↕</div>

                    <div class="label">${i+1}</div>
                    <div>
                    <div class="title">${escapeHtml(r.title||'')}</div>
                    <div class="addr">${escapeHtml(r.addr||'')}</div>
                    <div class="meta">위도 ${(+r.lat).toFixed(5)} / 경도 ${(+r.lng).toFixed(5)}</div>
                    <button class="ghost btn-fav-del" type="button">삭제</button>
                    <button class="btn-to-course" type="button">➕ 코스 담기</button>

                    </div>
                </div>`).join("")
                : `<div class="empty">즐겨찾기가 비어있어요</div>`
            }
        </div>

        <div style="padding:8px 10px;color:#9fb9e8">내 코스</div>
        <div id="courseList">
            ${courseItems.length ? courseItems.map((c,i)=>`
            <section class="course" data-cid="${c.id}">
                <div class="course-header" style="padding:10px;border-bottom:1px solid #1f2b3f;background:rgba(172,225,215,0.7)">
                <div style="display:flex;justify-content:space-between;align-items:center">
                    <div><b>${escapeHtml(c.title||'내 코스')}</b> <span class="addr" style="opacity:.8">${(c.spots||[]).length}곳</span></div>
                    <div>
                        <button class="ghost" data-act="expand" aria-expanded="false" data-id="${c.id}">보기 ▾</button>
                    </div>
                </div>
                    <div class="course-items" style="display:none"></div>
                </div>
            </section>`).join("")
            : `<div class="empty">저장한 코스가 없어요</div>`
            }
        </div>
        `;

    if (window.mineExpandedId) {
        const sec = document
            .getElementById('panel-mine')
            ?.querySelector(`section.course[data-cid="${window.mineExpandedId}"]`);

        if (sec) {
            const list = sec.querySelector('.course-items');
            const course = (window.mySavedCourses || [])
            .find(c => String(c.id) === String(window.mineExpandedId));
            const spots = course?.spots || [];

            if (list) {
            list.innerHTML = spots.map((s, i) => `
                <div class="item" data-id="${s.id || s.place_id || s.placeId}">
                <div class="dnd-handle" draggable="true" title="드래그로 순서 바꾸기">↕</div>
                <div class="label">${i + 1}</div>
                <div>
                    <div class="title">${escapeHtml(s.title || s.name || '')}</div>
                    <div class="addr">${escapeHtml(s.addr || s.address || '')}</div>
                    <button class="ghost btn-spot-del" data-id="${s.id || s.place_id || s.placeId}" type="button">삭제</button>
                    
                </div>
                </div>
            `).join('') || `<div class="empty">장소가 없습니다</div>`;

            list.style.display = 'block';
            list.dataset.rendered = '1'; // 복구 시에도 '렌더 완료'로 표시
            }

            sec.querySelector('.btn-course-toggle,[data-act="expand"]')
            ?.setAttribute('aria-expanded','true');
        }
    }

    // 이벤트 위임: 즐겨찾기 삭제/코스 열기/삭제
    // 내 보관함(#panel-mine) 클릭 위임
    const panel = document.getElementById('panel-mine');
    if (panel && !panel.dataset.boundMineCourse) {
    panel.dataset.boundMineCourse = '1';

    panel.addEventListener('click', async (e) => {
    // 1) 스폿 삭제 버튼
        const delSpotBtn = e.target.closest('.btn-spot-del');
        if (delSpotBtn) {
            const section = delSpotBtn.closest('section.course');
            const cid  = section?.dataset.cid;
            const sid  = delSpotBtn.dataset.id || delSpotBtn.closest('.item')?.dataset.fid;
            if (!cid || !sid) return;

            if (confirm('이 장소를 코스에서 삭제할까요?')) {
                removeSpotFromCourse(cid, sid, { stayInMine: true, silent: true });
            }
            return; // 다른 분기(확대/펼치기/삭제 등)로 내려가지 않게 종료
        }

        // 1) 코스 펼치기/접기 (내 보관함에서 바로 펼침)
        const expandBtn = e.target.closest('[data-act="expand"], .btn-course-open, .btn-course-toggle');
        if (expandBtn) {
        const sec  = expandBtn.closest('section.course');
        const cid  = sec?.dataset.cid;
        window.mineExpandedId = cid
        // 섹션 안에 숨긴 리스트 컨테이너(최초 렌더에 포함됨)
        let list = sec.querySelector('.course-items');
        if (!cid) return;

        // 최초 1회 렌더
        if (list && !list.dataset.rendered) {
            const course = (window.mySavedCourses || []).find(c => String(c.id) === String(cid));
            const spots  = course?.spots || [];
            list.innerHTML = spots.map((s, i) => `
            <div class="item" data-id="${s.id || s.place_id || s.placeId}">
                <div class="label">${i + 1}</div>
                <div>
                <div class="title">${escapeHtml(s.title || s.name || '')}</div>
                <div class="addr">${escapeHtml(s.addr || s.address || '')}</div>
                <button class="ghost btn-spot-del" data-id="${s.id || s.place_id || s.placeId}" type="button">삭제</button>
                </div>
            </div>
            `).join('') || `<div class="empty">장소가 없습니다</div>`;
            list.dataset.rendered = '1';
            list.style.display = 'block';
            expandBtn.setAttribute('aria-expanded','true');
            expandBtn.textContent = '접기 ▴';
        }

        // 아코디언 토글
        const willOpen = list && getComputedStyle(list).display === 'none';
        panel.querySelectorAll('section.course .course-items').forEach(el => { if (el !== list) el.style.display = 'none'; });
        panel.querySelectorAll('section.course [data-act="expand"]').forEach(b => {
            if (b !== expandBtn) { b.setAttribute('aria-expanded','false'); b.textContent = '보기 ▾'; }
        });
        if (list) {
            list.style.display = willOpen ? 'block' : 'none';
            expandBtn.setAttribute('aria-expanded', String(willOpen));
            expandBtn.textContent = willOpen ? '숨기기 ▴' : '보기 ▾';
        }

        // 지도에는 해당 코스만 표시
        showSavedCourseById(cid); // :contentReference[oaicite:3]{index=3}
        return;
        }

        // 2) 코스 삭제 (두 클래스 모두 지원)
        const delBtn = e.target.closest('.btn-spot-del');
        if (delBtn) {
            const sec = delBtn.closest('section.mine-course, section.course');
            const courseId = sec?.getAttribute('data-cid');
            const spotId = delBtn.dataset.id || delBtn.closest('.item')?.dataset.id;
            if (courseId && spotId && confirm('이 장소를 코스에서 삭제할까요?')) {
                removeSpotFromCourse(courseId, spotId, { stayInMine: true });
            }
            return;
        }

        // 3) 코스 안의 장소 클릭 → 지도 이동/하이라이트
        const item = e.target.closest('#courseList .course .course-items .item[data-id]');
        if (item) {
        selectPlace(item.dataset.id, { pan:true, ping:true, keepCourses:true });
        return;
        }
    });
    }

    if (panel) {
    // 드래그 핸들만 끌 수 있게 보장
    panel.querySelectorAll('.item[data-fid]').forEach(it => it.removeAttribute('draggable'));
    panel.querySelectorAll('.item .dnd-handle').forEach(h => h.setAttribute('draggable','true'));

    // 드래그 중 클릭 무시
    // 드래그 시작: 끌리는 아이템 표시
    panel.addEventListener('dragstart', (e) => {
    const item = e.target.closest('.course-items .item[draggable="true"]');
    if (!item) return;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', item.dataset.id);
    item.classList.add('dragging');
    });

    // 드래그 종료: 표시 제거
    panel.addEventListener('dragend', (e) => {
    e.target.closest('.item')?.classList.remove('dragging');
    });

    // 드래그 중: 마우스 위치 기준으로 DOM 내 위치 미리 바꾸기
    panel.addEventListener('dragover', (e) => {
    const list = e.target.closest('.course-items');
    if (!list) return;
    e.preventDefault();
    const dragging = list.querySelector('.item.dragging');
    if (!dragging) return;

    const after = (() => {
        const items = Array.from(list.querySelectorAll(':scope > .item:not(.dragging)'));
        return items.reduce((closest, el) => {
        const box = el.getBoundingClientRect();
        const offset = e.clientY - box.top - box.height / 2;
        return (offset < 0 && offset > closest.offset) ? { offset, el } : closest;
        }, { offset: Number.NEGATIVE_INFINITY, el: null }).el;
    })();

    if (after == null) list.appendChild(dragging);
    else list.insertBefore(dragging, after);
    });

    // 드랍: 최종 순서 저장
    panel.addEventListener('drop', async (e) => {
        const list = e.target.closest('.course-items');
        if (!list) return;
        if (panel.dataset.reordering === '1') return;     // ★ 중복 방지
        panel.dataset.reordering = '1';
        try {
            e.preventDefault();
            const sec = list.closest('section.course');
            const cid = sec?.dataset.cid;
            if (!cid) return;

            const newOrder = Array.from(list.querySelectorAll(':scope > .item[data-id]')).map(el => el.dataset.id);
            const ok = await reorderCourseSpots(cid, newOrder); // 아래 3) 함수
            if (ok) {
                // 라벨 재번호
                Array.from(list.querySelectorAll('.item .label')).forEach((el, i) => {
                    el.textContent = i + 1;
                });
            }
        } finally{
            delete panel.dataset.reordering;
        }

    });

    // ★ 클릭 및 키보드(Enter/Space)로 장소 선택
    if (!panel.dataset.boundClicks) {
        panel.addEventListener('click', (e) => {
        if (_favDragging && e.target.closest(".dnd-handle")) return;                 // 드래그 중이면 무시
        if (e.target.closest('button')) return;   // 삭제 등 버튼 클릭은 무시

        const row = e.target.closest('.item[data-fid]');
        if (!row) return;

        const id = row.dataset.fid;
        try { updateMapByContext?.('mine'); } catch {}
        selectPlace(id, { pan: true, ping: true });

        // 리스트 하이라이트 & 스크롤
        panel.querySelectorAll('.item.active').forEach(n => n.classList.remove('active'));
        row.classList.add('active');
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });

        panel.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const row = e.target.closest('.item[data-fid]');
        if (!row) return;
        e.preventDefault();

        const id = row.dataset.fid;
        try { updateMapByContext?.('mine'); } catch {}
        selectPlace(id, { pan: true, ping: true });

        panel.querySelectorAll('.item.active').forEach(n => n.classList.remove('active'));
        row.classList.add('active');
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });

        panel.dataset.boundClicks = '1';
    }
    }


    makeFavListSortable();
    ensureDndHandlePresent();
    if (!MOBILE_Q.matches && document.querySelector('.tabs .tab.active')?.dataset.tab === 'mine') {
        updateMapByContext('mine');
    }
    // 핸들만 draggable 활성화
    function enforceHandleOnlyDrag() {
    const list = document.getElementById('favList');
    if (!list) return;
    list.querySelectorAll('.item[data-fid]').forEach((it) => it.removeAttribute('draggable'));
    list.querySelectorAll('.item .dnd-handle').forEach((h) => h.setAttribute('draggable', 'true'));
    }
    enforceHandleOnlyDrag();

}

qs('#btnMyBox').onclick = () => {
    document.querySelector('.tabs .tab[data-tab="mine"]')?.click();
    openSheetToPercent?.(0.62);
    loadMyBox();
};

// 내여행 추가하기
let draft = []; // {id,title,subtitle,lat,lng}
let courseDraft = null;

//옵션
document.getElementById('mapTools').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'fit' && last?.pins?.length) {
        const bds = new kakao.maps.LatLngBounds();
        last.pins.forEach(p => bds.extend(new kakao.maps.LatLng(p.lat, p.lng)));
        map.setBounds(bds);
    }
    if (act === 'road') map.setMapTypeId(kakao.maps.MapTypeId.ROADMAP);
    if (act === 'sky') map.setMapTypeId(kakao.maps.MapTypeId.HYBRID);
    if (act === 'routes-on') polylines.forEach(p => p.setMap(map));
    if (act === 'routes-off') polylines.forEach(p => p.setMap(null));
};

// --- TourAPI → 코스 담기 유틸 ---
function ensureCourseDraft() {
    if (!auth?.user) {
        toast('로그인이 필요합니다');
        return false;
    }
    if (!courseDraft) {
        toast('우하단 ＋ 버튼으로 담기 모드를 켜세요');
        return false;
    }
    return true;
}

// [PATCH] 코스 스팟 표준화: 항상 {id,title,addr,lat,lng}
function normalizeCourseDraft() {
  if (!courseDraft?.spots) return;
  courseDraft.spots = courseDraft.spots.map(s => ({
    id: s.id,
    title: s.title || '',
    addr: (s.addr ?? s.subtitle ?? ''),  // subtitle로 들어온 것 보정
    lat: +s.lat,
    lng: +s.lng,
  }));
}

function makeTourSpotIdFromData(title, addr, lat, lng) {
    const slug = (title || '').replace(/[^\w가-힣]/g, '').slice(0, 10);
    const a = Math.round((+lat) * 1e5),
        b = Math.round((+lng) * 1e5);
    return `tour_${a}_${b}_${slug}`;
}

// 코스 조작//

const fab = document.getElementById('fabTrip');
fab.onclick = async () => {
    if (!auth.user) {
        toast('로그인이 필요합니다');
        return;
    }
    // 모드 토글: 꺼져있으면 담기 시작, 켜져있으면 저장
    if (!courseDraft) {
        courseDraft = {
            id: null,
            title: `내 코스 (${new Date().toLocaleDateString()})`,
            notes: '',
            spots: []
        };
        fab.classList.add('active');
        toast('담기 모드: 목록의 ➕ 버튼으로 추가하세요');
   } else {
       if (!(courseDraft.spots?.length)) {
         toast('담긴 장소가 없어요');
         return;
       }
       try {
         // ★ addr/숫자형 보정
         normalizeCourseDraft();
 
         const r = await reqJSON('/api/user/courses', {
           method: 'POST',
           body: JSON.stringify(courseDraft)
         });
         if (!r?.ok) throw new Error('save_failed');
 
         // 서버가 반환하는 형태를 최대한 흡수
         const newCourse = r.course || { id: r.id, ...courseDraft };
 
         toast('코스 저장 완료');
         courseDraft = null;
         fab.classList.remove('active');
 
         // ★ 낙관적 반영 + 리스트 새로고침
         window.mySavedCourses = [newCourse, ...(window.mySavedCourses || [])];
         await loadMyBox();
 
         // ★ 보관함 탭으로 자동 전환 + 방금 저장한 코스 강조
         document.querySelector('.tabs .tab[data-tab="mine"]')?.click();
         const row = (newCourse?.id
           ? document.querySelector(`#courseList .course[data-cid="${newCourse.id}"]`)
           : document.querySelector('#courseList .course'));
         if (row) {
           row.classList.add('blink');           // 임시 강조(아래 CSS 참고)
           setTimeout(() => row.classList.remove('blink'), 1200);
         }
       } catch (e) {
         console.error(e);
         toast(auth?.user ? '코스 저장 실패: 다시 시도해주세요' : '로그인이 필요합니다');
       }
   }
};

// 탭 클릭 바인딩 바로 아래에 추가
document.querySelector('.tabs .tab[data-tab="options"]')?.remove();
document.getElementById('panel-options')?.remove();

// 상단 어딘가 전역에 추가
let _zoomCtrlAdded = false;

// mFitAll
on('mFitAll','click', () =>  {
    if (!last?.pins?.length) { toast('표시할 핀이 없습니다'); return; }
    const b = new kakao.maps.LatLngBounds();
    last.pins.forEach(p => { if (typeof p.lat==='number'&&typeof p.lng==='number') b.extend(new kakao.maps.LatLng(p.lat,p.lng)); });
    map.setBounds(b);
    if (MOBILE_Q.matches) {
        openSheetToPercent(0.62);
        if (!_zoomCtrlAdded) {
            const zc = new kakao.maps.ZoomControl();
            map.addControl(zc, kakao.maps.ControlPosition.RIGHT);
            _zoomCtrlAdded = true;
        }
    }
});

// mMyBox
document.getElementById('mMyBox').addEventListener('click', () => {
    document.querySelector('.tabs .tab[data-tab="mine"]')?.click();
    loadMyBox();
    if (MOBILE_Q.matches) {
        openSheetToPercent(0.62);
        if (!_zoomCtrlAdded) {
            const zc = new kakao.maps.ZoomControl();
            map.addControl(zc, kakao.maps.ControlPosition.RIGHT);
            _zoomCtrlAdded = true;
        }
    }
});

// 모바일: 로그인/로그아웃 토글 (PC 버튼 핸들러 재사용)
on('mLogin','click', () => {
    document.getElementById('btnLogin')?.click();
});

// 로그인 상태 반영해서 모바일 버튼 라벨도 동기화
const _origSetAuthUI = setAuthUI;
setAuthUI = function() {
    _origSetAuthUI?.();
    const mLoginBtn = document.getElementById('mLogin');
    if (mLoginBtn) mLoginBtn.textContent = auth.user ? `${auth.user.username} 로그아웃` : '로그인';
};

// 모드에 따른 캐시체크 활성/비활성 (PC와 동일 규칙)
document.getElementById('mMode').addEventListener('change', () => {
    toggleUpdateOption(qs('#mMode'), qs('#mDoRefresh'));
});

qsa('.badge').forEach(b => {
    b.addEventListener('click', () => {
        const text = b.textContent.replace('예:', '').trim();
        if (MOBILE_Q.matches) {
            qs('#mKeyword').value = text;
            qs('#mGo').click();
        } else {
            qs('#keyword').value = text;
            qs('#go').click();
        }
    });
});

// 초기 바인딩
qs("#mode")?.addEventListener("change", () => toggleUpdateOption(qs("#mode"), qs("#doRefresh")));
qs("#mMode")?.addEventListener("change", () => toggleUpdateOption(qs("#mMode"), qs("#mDoRefresh")));
toggleUpdateOption(qs("#mode"), qs("#doRefresh"));
toggleUpdateOption(qs("#mMode"), qs("#mDoRefresh"));

// 모바일 인라인 검색 실행 공용 함수
function runMobileInlineSearch() {
    const modeEl = document.getElementById('mModeInline');
    const kwEl = document.getElementById('mKeywordInline');
    if (!modeEl || !kwEl) return;

    const m = modeEl.value;
    const k = kwEl.value.trim();
    if (!k) {
        toast("키워드를 입력하세요");
        return;
    }
    LAST_KEYWORD = k;

    // 인라인에선 '업데이트' 옵션 없음 → 기본 false
    if (m === "actor") {
        searchActor(k);
    } else {
        searchWork(k, m, {
            willUpdate: false
        });
    }
}

// Fit all
on('fitAll','click', () => {
    if (!last?.pins?.length) return;
    const b = new kakao.maps.LatLngBounds();
    last.pins.forEach(p => {
        if (typeof p.lat === "number" && typeof p.lng === "number") b.extend(new kakao.maps.LatLng(p.lat, p.lng));
    });
    map.setBounds(b);
});

// Filter
qs("#filter").addEventListener("input", (e) => {
  const v = (e.target.value || "").trim();
  qs("#panel-results").querySelectorAll(".item").forEach(it => {
    const hit = (it.textContent || "").includes(v);
    it.style.display = (!v || hit) ? "" : "none"; // 기본 display:flex를 되살리려면 ""가 안전
  });
});
qs("#clearFilter").addEventListener("click", () => {
    qs("#filter").value = "";
    qs("#filter").dispatchEvent(new Event("input"));
});

// Options
const sheet = qs("#sheet"),
  handle = qs("#sheetHandle"),
  searchDock = qs("#searchDock");
let dragging = false, startY = 0, startTop = 0;

function minSheetTop() {
    const rect = searchDock?.getBoundingClientRect?.();
    return Math.max(111, (rect ? rect.bottom : 103) + 8);
}

function collapsedTop() {
    return window.innerHeight - 140;
}

function openSheetTo(top) {
  if (!sheet) return;
  sheet.style.top = Math.max(minSheetTop(), Math.min(collapsedTop(), top)) + "px";
}
function snapSheet() {
  if (!sheet) return;
  const mid = (minSheetTop() + collapsedTop()) / 2;
  const curTop = sheet.offsetTop;
  if (window._sheetHoldUntil && Date.now() < window._sheetHoldUntil) return;
  openSheetTo(curTop < mid ? minSheetTop() : collapsedTop());
}

function layoutInit() {
    if (MOBILE_Q.matches) {
        openSheetTo(collapsedTop());
    }
}
layoutInit();
window.addEventListener('resize', layoutInit);

// ✅ 드래그 시작 조건: (1) 그립바 or (2) 탭 바 or (3) 시트 상단 80px 영역
function startDrag(y) {
    dragging = true;
    startY = y;
    startTop = sheet.offsetTop;
}

function onTouchStart(e) {
  if (!sheet) return;
  const t = e.touches?.[0]; if (!t) return;
  const y = t.clientY;
  const top = sheet.getBoundingClientRect().top;
  const hitTop = y - top;
  const inTopZone = hitTop <= 80;
  if (e.target?.id === 'sheetHandle' || inTopZone) { startDrag(y); }
}
handle?.addEventListener('touchstart', onTouchStart, { passive: true });
sheet?.addEventListener('touchstart', onTouchStart, { passive: true });

window.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    e.preventDefault();
    const y = e.touches[0].clientY;
    openSheetTo(startTop + (y - startY));
}, {
    passive: false
});

window.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    snapSheet();
}, {
    passive: true
});

qsa('.sheet-tab').forEach(t => {
  t.addEventListener('click', () => {
    const k = t.dataset.stab || 'results'; // 'results' | 'courses' | 'mine'

    // 탭 UI
    qsa('.sheet-tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');

    // 시트 내부 패널 전환
    ['results','courses','mine'].forEach(name => {
      const el = qs(`#m-${name}`);
      if (el) el.style.display = (name === k) ? 'block' : 'none';
    });

    // 지도 표시 컨텍스트 동기화
    updateMapByContext(k);

    // 시트 높이 안정화
    try { openSheetToPercent?.(0.62); } catch {}
  });
});

qsa('.tab').forEach(t => {
    t.addEventListener('click', async () => {
        qsa('.tab').forEach(x => {
            x.classList.remove('active');
            x.setAttribute('aria-selected', 'false');
        });
        t.classList.add('active');
        t.setAttribute('aria-selected', 'true');
        ['results', 'courses', 'mine'].forEach(name => {
            const el = qs(`#panel-${name}`);
            if (el) el.style.display = (t.dataset.tab === name) ? 'block' : 'none';
        });

        // 내 보관함이면 데이터 동기화 후 지도 갱신
        if (t.dataset.tab === 'mine') {
            await loadMyBox(); // 내부에서 myFavItems를 갱신
            updateMapByContext('mine');
        } else {
            updateMapByContext(t.dataset.tab); // results / courses
        }
    });
});

// Demo chips
qsa('.badge').forEach(b => {
    b.addEventListener('click', () => {
        const text = b.textContent.replace('예:', '').trim();
        if (MOBILE_Q.matches) {
            qs('#mKeyword').value = text;
        } else {
            qs('#keyword').value = text;
        }
    });
});




let FAVORITES_REORDER_SUPPORTED = undefined; // true/false/undefined

async function persistFavoriteOrder(orderIds) {
    // 서버 미지원으로 판정되면 바로 로컬 저장
    if (FAVORITES_REORDER_SUPPORTED === false) {
        localStorage.setItem('favOrder', JSON.stringify(orderIds));
        return;
    }
    try {
        await reqJSON('/api/user/favorites/reorder', {
            method: 'POST',
            body: JSON.stringify({
                ids: orderIds
            })
        });
        FAVORITES_REORDER_SUPPORTED = true;
        toast('순서 저장됨');
    } catch (e) {
        // 405면 앞으로 서버 호출 스킵
        if (String(e?.message || '').startsWith('HTTP 405')) {
            FAVORITES_REORDER_SUPPORTED = false;
            if (!window.__reorderToastShown) {
                window.__reorderToastShown = true;
                toast('서버가 순서저장을 지원하지 않아 로컬에 저장합니다');
            }
        }
        localStorage.setItem('favOrder', JSON.stringify(orderIds));
        if (FAVORITES_REORDER_SUPPORTED !== false) {
            toast('순서 저장됨(로컬)');
        }
    }
}


const FAV_ORDER_KEY = 'favOrder.v1';

function getFavOrder() {
  try { return JSON.parse(localStorage.getItem(FAV_ORDER_KEY) || '[]'); } catch { return []; }
}



// chatFab.addEventListener('click', () => {
//     chatPanel.style.display = (chatPanel.style.display === 'flex') ? 'none' : 'flex';
// });
// chatClose.addEventListener('click', () => {
//     chatPanel.style.display = 'none';
// });


/* =========================
 * AI 도슨트 위젯 (chatFab / chatPanel)
 * ========================= */
(() => {
  const chatFab      = document.getElementById('chatFab');
  const chatPanel    = document.getElementById('chatPanel');
  const chatClose    = document.getElementById('chatClose');
  const chatMessages = document.getElementById('chatMessages');
  const chatInput    = document.getElementById('chatInput');
  const chatSend     = document.getElementById('chatSend');

  // 혹시 이 HTML이 없는 페이지에서도 app.js를 재사용할 수 있으니까 방어
  if (!chatFab || !chatPanel || !chatMessages || !chatInput || !chatSend) {
    return;
  }

  // 패널 열고 닫기
  function openChat() {
    chatPanel.style.display = 'flex';
  }
  function closeChat() {
    chatPanel.style.display = 'none';
  }

  chatFab.addEventListener('click', () => {
    if (chatPanel.style.display === 'flex') {
      closeChat();
    } else {
      openChat();
    }
  });

  chatClose?.addEventListener('click', closeChat);

  // 말풍선 DOM 추가
  function pushChatBubble(sender, text) {
    const bubble = document.createElement('div');
    bubble.style.maxWidth     = '85%';
    bubble.style.borderRadius = '10px';
    bubble.style.padding      = '8px 10px';
    bubble.style.whiteSpace   = 'pre-wrap';
    bubble.style.wordBreak    = 'break-word';
    bubble.style.fontSize     = '13px';
    bubble.style.lineHeight   = '1.4';

    if (sender === 'user') {
      bubble.style.alignSelf   = 'flex-end';
      bubble.style.background  = '#4f46e5';
      bubble.style.color       = '#fff';
    } else {
      bubble.style.alignSelf   = 'flex-start';
      bubble.style.background  = '#374151';
      bubble.style.color       = '#fff';
    }

    bubble.textContent = text;
    chatMessages.appendChild(bubble);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // ✅ 여기서 KHT용 컨텍스트만 뽑는다
  // - 작품(드라마/영화) 제목: last.meta.title_ko || last.meta.title
  // - 현재 선택된 장소 제목/주소: #pd-title / #pd-addr
  function getCurrentContextForAI() {
    const dramaTitle =
      (last && last.meta && (last.meta.title_ko || last.meta.title)) || '';

    const placeTitle =
      document.getElementById('pd-title')?.textContent?.trim() || '';

    const placeAddr =
      document.getElementById('pd-addr')?.textContent?.trim() || '';

    return {
      drama: dramaTitle,
      place: placeTitle,
      addr: placeAddr
    };
  }

  // 서버 전송
  async function sendChat() {
    const userText = (chatInput.value || '').trim();
    if (!userText) return;

    // 내 메시지 찍고 입력창 비우기
    pushChatBubble('user', userText);
    chatInput.value = '';

    try {
      const resp = await fetch(`${API_BASE}/api/chatbot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: userText,
          context: getCurrentContextForAI()
        })
      });

      let data;
      try {
        data = await resp.json();
      } catch (parseErr) {
        console.error('JSON parse error', parseErr);
        pushChatBubble('bot', '서버 응답을 해석하지 못했어요 😥');
        return;
      }

      pushChatBubble('bot', data.answer || '(응답 없음)');
    } catch (err) {
      console.error(err);
      pushChatBubble('bot', '에러가 발생했어요 😥');
    }
  }

  chatSend.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });
})();



function getFavIdsFromDOM() {
  return qsa('#favList .item[data-fid]').map(n => n.dataset.fid);
}


// 1) 모바일 키보드 내리기
function dismissKeyboard() {
    try {
        document.activeElement && document.activeElement.blur();
    } catch {}
    window.scrollTo(0, 0);
}

// === 모바일: 버튼 동작 연결 ===
const mFitAll = qs('#mFitAll');
if (mFitAll) mFitAll.addEventListener('click', () => {
    dismissKeyboard?.();
    fitAllByContext();
});

const fitAll = qs('#fitAll'); // 데스크톱 버튼도 같은 로직 사용
if (fitAll) fitAll.addEventListener('click', fitAllByContext);

// 로그인/로그아웃: 데스크톱과 동일 동작 재사용
function openLoginOrLogout() {
    if (auth.user) {
        auth.logout().then(() => {
            setAuthUI();
            resetToInitialView?.();
            toast('로그아웃 됐어요');
        });
    } else {
        qs('#authModal').style.display = 'block';
    }
}
const mLogin = qs('#mLogin');
if (mLogin) mLogin.addEventListener('click', () => {
    dismissKeyboard?.();
    openLoginOrLogout();
});

async function showMineOnMobile(){
  dismissKeyboard?.();
  if (!auth?.user) { toast('로그인이 필요합니다'); openLoginOrLogout(); return; }
  await loadMyBox();
  const tabs = document.querySelector('.sheet-tabs');
  tabs?.querySelectorAll('.sheet-tab').forEach(el => el.classList.remove('active'));
  tabs?.querySelector('.sheet-tab[data-stab="mine"]')?.classList.add('active');
  ['results','courses','mine'].forEach(k => {
    const el = document.getElementById('m-' + k);
    if (el) el.style.display = (k === 'mine') ? 'block' : 'none';
  });
  updateMapByContext('mine');
  openSheetToPercent?.(0.62);
}

const mMyBoxBtn = document.getElementById('mMyBox');
if (mMyBoxBtn) mMyBoxBtn.addEventListener('click', showMineOnMobile);

// 인라인 액션 프록시 (모바일)
(() => {
    const fitAllInline = document.getElementById('mFitAllInline');
    const myBoxInline = document.getElementById('mMyBoxInline');
    const loginInline = document.getElementById('mLoginInline');

    // 기존 모바일 버튼/기능으로 위임
    fitAllInline && (fitAllInline.onclick = () => document.getElementById('mFitAll')?.click());
    myBoxInline && (myBoxInline.onclick = () => document.getElementById('mMyBox')?.click());
    loginInline && (loginInline.onclick = () => document.getElementById('mLogin')?.click());

    // ‘업데이트’ 체크박스: 배우 모드일 땐 비활성
    const modeEl = document.getElementById('mModeInline');
    const cbUpd = document.getElementById('mDoRefreshInline');

    function syncInlineUpdate() {
        if (!modeEl || !cbUpd) return;
        const isActor = modeEl.value === 'actor';
        cbUpd.disabled = isActor;
        if (isActor) cbUpd.checked = false;
    }
    modeEl && modeEl.addEventListener('change', syncInlineUpdate);
    syncInlineUpdate();
})();

// === 모바일 "검색창 바로 옆" 인라인 제어 ===
(() => {
    const $ = (s) => document.querySelector(s);

    // 1) 인라인 검색 실행 (mGoInline)
    const btnGoInline = $('#mGoInline');
    if (btnGoInline) {
        btnGoInline.addEventListener('click', () => {
            // 키보드 내리기(프로젝트에 이미 있으면 호출, 없어도 무시)
            try {
                dismissKeyboard?.();
            } catch {}

            const modeEl = $('#mModeInline');
            const kwEl = $('#mKeywordInline');
            const optUpd = $('#mDoRefreshInline');

            const m = modeEl?.value || 'drama';
            const kw = (kwEl?.value || '').trim();
            const willUpdate = !!optUpd?.checked;

            if (!kw) {
                toast('키워드를 입력하세요');
                return;
            }

            // 진행배지: 배우/미업데이트면 트래킹 안 함
            window.CURRENT_REFRESH_TITLE = (m === 'actor' || !willUpdate) ? null : kw;

            window.LAST_KEYWORD = kw;
            if (m === 'actor') searchActor(kw);
            else searchWork(kw, m, {
                willUpdate
            });
        });

        // Enter로도 실행
        $('#mKeywordInline')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') btnGoInline.click();
        });
    }

    // 2) ‘업데이트’ 체크박스: 배우 모드일 때 비활성화
    const modeInline = $('#mModeInline');
    const updInline = $('#mDoRefreshInline');

    function syncInlineUpdate() {
        if (!modeInline || !updInline) return;
        const isActor = modeInline.value === 'actor';
        updInline.disabled = isActor;
        if (isActor) updInline.checked = false;
    }
    modeInline?.addEventListener('change', syncInlineUpdate);
    syncInlineUpdate(); // 초기 1회

    // 3) 인라인 보조 버튼들 → 기존 모바일 버튼으로 프록시
    const proxyClick = (fromSel, toSel) => {
        const from = $(fromSel),
            to = $(toSel);
        if (from && to) from.addEventListener('click', () => to.click());
    };
    proxyClick('#mFitAllInline', '#mFitAll'); // 전체보기
    proxyClick('#mMyBoxInline', '#mMyBox'); // 내 보관함
    proxyClick('#mLoginInline', '#mLogin'); // 로그인
})();

// 현재 컨텍스트(결과/코스/내 보관함)에 맞춰 지도 전체보기
function fitAllByContext() {
    if (!window.map) return;

    const sideActive = document.querySelector('.tabs .tab.active')?.dataset.tab || 'results';
    let pins = [];

    if (sideActive === 'courses') {
        // 코스에 포함된 핀만
        if (typeof getCoursePinsOnly === 'function') pins = getCoursePinsOnly() || [];
    } else if (sideActive === 'mine') {
        // 내 보관함 핀
        pins = (window.myFavItems || []).map(r => ({
            lat: +r.lat,
            lng: +r.lng
        }));
    } else {
        // 기본: 검색결과 핀
        pins = (window.last && window.last.pins) ? window.last.pins : [];
    }

    const b = new kakao.maps.LatLngBounds();
    let has = false;
    pins.forEach(p => {
        const lat = +p.lat,
            lng = +p.lng;
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            b.extend(new kakao.maps.LatLng(lat, lng));
            has = true;
        }
    });

    if (has) {
        map.setBounds(b);
        // 모바일에선 지도 좀 더 보이게 시트 살짝 내리기
        if (window.MOBILE_Q?.matches && typeof openSheetToPercent === 'function') {
            openSheetToPercent(0.62);
        }
    } else {
        // 핀이 없을 때는 가볍게 토스트 정도
        try {
            toast('표시할 위치가 없습니다');
        } catch {}
    }
}
// ==== 안전한 no-op/유틸 ====
function dismissKeyboard() {
    try {
        document.activeElement && document.activeElement.blur && document.activeElement.blur();
    } catch {}
}



function getDragAfterElement(container, mouseY) {
  const items = [...container.querySelectorAll('.item[data-fid]:not(.dragging)')];
  return items.reduce((closest, child) => {
    const box = child.getBoundingClientRect();
    const offset = mouseY - (box.top + box.height / 2);
    // 마우스 위쪽에 있으면서, 가장 가까운 요소를 고름
    if (offset < 0 && offset > closest.offset) {
      return { offset, element: child };
    }
    return closest;
  }, { offset: Number.NEGATIVE_INFINITY, element: null }).element;
}



// TourAPI → 코스 담기
// function addTourItemToCourse({ id, title, addr, lat, lng }) {
//   if (!ensureCourseDraft()) return;
//   const spot = { id, title, subtitle: addr || '', lat: +lat, lng: +lng };
//   if (!courseDraft.spots.find(s => s.id === id)) {
//     courseDraft.spots.push(spot);
//     toast('코스에 담겼어요');
//   } else {
//     toast('이미 담긴 장소입니다');
//   }
// }

function addTourItemToCourse({ id, title, addr, lat, lng }) {
  if (!ensureCourseDraft()) return;
  if (!courseDraft.spots.find(s => s.id === id)) {
    courseDraft.spots.push({ id, title, addr, lat, lng });   // ★ addr로 저장
    toast('코스에 담겼어요');
  } else {
    toast('이미 코스에 담긴 장소예요');
  }
}

// ==== fitAllByContext 구현 + 버튼 바인딩 ====
function fitAllByContext() {
    if (!window.map) return;
    const sideActive = document.querySelector('.tabs .tab.active')?.dataset.tab || 'results';
    let pins = [];

    if (sideActive === 'courses') {
        if (typeof getCoursePinsOnly === 'function') pins = getCoursePinsOnly() || [];
    } else if (sideActive === 'mine') {
        pins = (window.myFavItems || []).map(r => ({
            lat: +r.lat,
            lng: +r.lng
        }));
    } else {
        pins = (window.last && window.last.pins) ? window.last.pins : [];
    }

    const b = new kakao.maps.LatLngBounds();
    let has = false;
    pins.forEach(p => {
        const lat = +p.lat,
            lng = +p.lng;
        if (Number.isFinite(lat) && Number.isFinite(lng)) {
            b.extend(new kakao.maps.LatLng(lat, lng));
            has = true;
        }
    });

    if (has) {
        map.setBounds(b);
        if (window.MOBILE_Q?.matches) openSheetToPercent(0.62);
    } else {
        try {
            toast('표시할 위치가 없습니다');
        } catch {}
    }
}
// 버튼들 연결(PC/모바일/도구)
[
    ['#fitAll'],
    ['#mFitAll'],
    ['#mFitAllInline']
].forEach(([sel]) => {
    const b = document.querySelector(sel);
    if (b) b.onclick = fitAllByContext;
});
document.getElementById('mapTools')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'fit') return fitAllByContext();
    if (act === 'road') map && map.setMapTypeId(kakao.maps.MapTypeId.ROADMAP);
    if (act === 'sky') map && map.setMapTypeId(kakao.maps.MapTypeId.HYBRID);
    if (act === 'routes-on') polylines.forEach(p => p.setMap(map));
    if (act === 'routes-off') polylines.forEach(p => p.setMap(null));
});



// ==== '전체보기' 추가 바인딩(PC 검색줄/모바일 도크는 위에서 연결) ====
document.getElementById('mFitAll') && (document.getElementById('mFitAll').onclick = fitAllByContext);

// ==== 엔터키 검색 바인딩(PC/모바일/인라인) ====
[
    ['#keyword', '#go'],
    ['#mKeyword', '#mGo'],
    ['#mKeywordInline', '#mGoInline']
].forEach(([inputSel, btnSel]) => {
    const ip = document.querySelector(inputSel),
        btn = document.querySelector(btnSel);
    if (!ip || !btn) return;
    ip.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            btn.click();
        }
    });
});

(function() {
    function placeMapToolsUnderSearch() {
        if (window.matchMedia('(min-width: 760px)').matches) return; // 데스크톱은 유지
        const tools = document.getElementById('mapTools');
        const header = document.querySelector('header.topbar');
        if (!tools || !header) return;

        const rect = header.getBoundingClientRect();
        // 헤더 하단 + 여백 8px 바로 아래에 위치
        tools.style.top = Math.ceil(rect.bottom + 8) + 'px';
        tools.style.bottom = 'auto';
        tools.style.left = '12px';
        tools.style.right = '12px';
    }

    // 최초, 리사이즈/회전, 폰트 로드 후 재계산
    window.addEventListener('load', placeMapToolsUnderSearch);
    window.addEventListener('resize', placeMapToolsUnderSearch);
    window.addEventListener('orientationchange', placeMapToolsUnderSearch);

    // 모바일 인라인 검색 UI가 높이를 바꾸는 시점 대비(탭 전환/메타 로드 등)
    const ro = new ResizeObserver(placeMapToolsUnderSearch);
    const headerEl = document.querySelector('header.topbar');
    if (headerEl) ro.observe(headerEl);
})();

function highlightListItem(placeId) {
    const el = document.querySelector(`.sheet-list .item[data-id="${placeId}"]`);
    if (el) {
        // 이전 active 제거
        document.querySelectorAll('.sheet-list .item.active')
            .forEach(it => it.classList.remove('active'));
        el.classList.add('active');

        // 스크롤 이동 (부드럽게, 중앙 근처로)
        el.scrollIntoView({
            behavior: "smooth",
            block: "center"
        });
    }
}

// 모바일 시트 펼치기 + 탭 보정
function ensureMobileSheetOpen(stab) {
    // 탭 전환 (results | courses)
    const tab = document.querySelector(`.sheet-tab[data-stab="${stab}"]`);
    if (tab && !tab.classList.contains('active')) tab.click();
    // 시트 펼치기 (위쪽으로)
    if (typeof openSheetTo === 'function' && typeof minSheetTop === 'function') {
        openSheetTo(minSheetTop());
    }
}

// === PC 검색 트리거 통합 ===
function triggerSearchPC() {
    const modeEl = document.getElementById('mode');
    const kwEl = document.getElementById('keyword');
    const refreshEl = document.getElementById('doRefresh');
    if (!modeEl || !kwEl) return;

    const mode = modeEl.value || 'drama';
    const kw = (kwEl.value || '').trim();
    const willUpdate = !!(refreshEl && refreshEl.checked);

    if (!kw) {
        toast('검색어를 입력하세요');
        kwEl.focus();
        return;
    }

    // 배우 모드/작품 모드 분기
    if (mode === 'actor') {
        searchActor(kw);
    } else {
        // mode: drama | film
        searchWork(kw, mode, {
            willUpdate
        });
    }
}

(function() {
    const mapTools = document.getElementById('mapTools');
    if (!mapTools) return;

    const MQ = window.matchMedia('(max-width: 759px)');

    function applyMobileLayout() {
        // 헤더 높이에 맞춰 위치 보정(모바일 전용)
        const header = document.querySelector('header.topbar');
        const h = header ? header.getBoundingClientRect().height : 60;
        mapTools.style.left = '12px';
        mapTools.style.right = '12px';
        mapTools.style.top = (h + 90) + 'px'; // 검색줄 바로 아래 정도로
        mapTools.style.bottom = 'auto';
        mapTools.style.flexDirection = 'row';
        mapTools.style.overflowX = 'auto';
    }

    function resetDesktopLayout() {
        // 모바일에서 남은 인라인 스타일 전부 제거 → CSS 데스크톱 규칙이 적용됨
        mapTools.style.left = '';
        mapTools.style.right = '';
        mapTools.style.top = '';
        mapTools.style.bottom = '';
        mapTools.style.flexDirection = '';
        mapTools.style.overflowX = '';
        mapTools.style.width = '';
        mapTools.style.maxWidth = '';
    }

    function onChange(e) {
        if (e.matches) { // 모바일 진입
            applyMobileLayout();
        } else { // 데스크톱 복귀
            resetDesktopLayout();
        }
    }

    // 초기 상태 반영
    onChange(MQ);
    // 뷰포트 전환 시 반영
    MQ.addEventListener ? MQ.addEventListener('change', onChange) :
        MQ.addListener(onChange);

    // 윈도 리사이즈 때도 모바일이면 top 다시 계산
    window.addEventListener('resize', () => {
        if (MQ.matches) applyMobileLayout();
    });
})();

// === 장소 → 위경도 얻기: Kakao Places ===
async function geocodeByPlaceKeyword(keyword) {
    return new Promise((resolve, reject) => {
        const ps = new kakao.maps.services.Places();
        ps.keywordSearch(keyword, (data, status) => {
            if (status !== kakao.maps.services.Status.OK || !data?.length) {
                return reject(new Error('장소를 찾지 못했습니다'));
            }
            // 가장 관련도 높은 1건
            const item = data[0];
            resolve({
                name: item.place_name,
                lat: +item.y,
                lng: +item.x,
                addr: item.road_address_name || item.address_name || ''
            });
        }, {
            size: 5
        });
    });
}

// 두 좌표 간 거리(m)
function haversine(a, b) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const s1 = Math.sin(dLat / 2),
        s2 = Math.sin(dLng / 2);
    const aa = s1 * s1 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * s2 * s2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(aa)));
}

// 서버에서 전체 촬영지(혹은 인덱스) 가져오는 엔드포인트가 있으면 사용
// 없으면 최근 검색(last.pins)만으로 필터링 가능(임시)
async function fetchAllPinsForNearby() {
    try {
        if (Array.isArray(last?.pins) && last.pins.length) return last.pins;
        return [];
    } catch {
        return [];
    }
}

// “장소” 모드 실행: 키워드 → (lat,lng) → 반경 5km 추천
async function searchPlace(keyword) {
    loadingOn();
    try {
        const place = await geocodeByPlaceKeyword(keyword); // ① 장소 좌표
        const allPins = await fetchAllPinsForNearby(); // ② 후보 촬영지 풀
        if (!allPins.length) {
            toast('추천할 촬영지 풀을 불러오지 못했습니다');
            loadingOff();
            return;
        }

        // ③ 5km 이내 필터
        const center = {
            lat: place.lat,
            lng: place.lng
        };
        const nearby = allPins
            .map(p => ({
                ...p,
                _dist: haversine(center, {
                    lat: +p.lat,
                    lng: +p.lng
                })
            }))
            .filter(p => Number.isFinite(p._dist) && p._dist <= 1000)
            .sort((a, b) => a._dist - b._dist)
            .slice(0, 50);

        // ④ 지도/리스트 렌더 (PC/모바일 모두)
        const data = {
            meta: {
                title: `${place.name} 주변 추천 촬영지`,
                released: '',
                poster: null,
                cast: []
            },
            pins: nearby.map(p => ({
                ...p,
                // 리스트에서 "어느 작품/영화"에 속했는지 표시(가능한 키 순서대로 사용)
                subtitle: p.subtitle || p.addr || p.address || '',
                _work: p.work_title || p.work || p.show || p.series || p.title_of_work || ''
            })),
            courses: [] // 장소 추천은 코스 기본 없음
        };
        last = data;

        // 지도에 센터 표시 + 핀
        // render(data);

        // 센터에 마커 하나(사용자 장소)도 보여주고 싶다면:
        const ll = new kakao.maps.LatLng(place.lat, place.lng);
        simpleMarker(ll, place.name, place.addr, 'search_center');
        map.setLevel(1, {
            anchor: ll
        });
        map.panTo(ll);

        // 좌측/모바일 리스트에 “작품명 배지”가 보이도록 UI에 한 줄 추가
        decorateListWithWorkLabels();

        toast(nearby.length ? `반경 5km 내 ${nearby.length}곳 추천` : '주변에 추천 촬영지가 없습니다');
    } catch (e) {
        console.warn(e);
        toast('장소를 찾지 못했습니다');
    } finally {
        loadingOff();
    }
}

// 리스트 항목에 “작품/영화” 텍스트를 보조로 붙이는 도우미
function decorateListWithWorkLabels() {
    const inject = (rootSel) => {
        document.querySelectorAll(`${rootSel} .item[data-id]`).forEach(it => {
            const id = it.getAttribute('data-id');
            const pin = (last?.pins || []).find(p => p.id === id);
            if (!pin || !pin._work) return;
            const metaLine = it.querySelector('.addr');
            if (metaLine && !metaLine.dataset._workAppended) {
                const info = document.createElement('div');
                info.className = 'meta';
                info.textContent = `작품: ${pin._work}`;
                metaLine.insertAdjacentElement('afterend', info);
                metaLine.dataset._workAppended = '1';
            }
        });
    };
    inject('#panel-results');
    inject('#m-results');
}

// 카카오 장소 검색 → 첫 결과 좌표 사용
async function searchPlaceByKeyword(keyword, radiusKm = 5) {
    if (!window.kakao?.maps?.services) {
        toast('카카오 장소검색을 사용할 수 없습니다');
        return;
    }

    const ps = new kakao.maps.services.Places();
    ps.keywordSearch(keyword, async (data, status) => {
        // 로딩 내려가는 건 무조건 실행되게 try/finally로 묶자
        try {
            if (status !== kakao.maps.services.Status.OK || !data?.length) {
                toast('장소를 찾지 못했습니다');
                return;
            }

            const first = data[0];
            const lat = +first.y;
            const lng = +first.x;

            // 서버에서 주변 촬영지 조회
            const url = API_BASE.replace(/\/$/, "") + "/api/spots/nearby?" + new URLSearchParams({
                lat,
                lng,
                radius_km: String(radiusKm),
                max: "80"
            });
            const r = await fetch(url);
            const j = await r.json();
            if (!j.ok) {
                toast('근처 촬영지 조회 실패');
                return;
            }

            const pins = (j.items || []).map(it => ({
                id: it.id,
                title: it.title,
                subtitle: `${it.subtitle} · 거리 ${it.dist_km}km`,
                lat: +it.lat,
                lng: +it.lng
            }));

            // 결과 렌더링
            render({
                meta: {
                    title: first.place_name,
                    released: "",
                    cast: []
                },
                pins,
                courses: []
            });

            // 지도 이동 + 마커
            const center = new kakao.maps.LatLng(lat, lng);
            map.setLevel(3, { anchor: center });
            map.panTo(center);

            const m = new kakao.maps.Marker({
                position: center,
                title: first.place_name
            });
            m.setMap(map);
            overlays.push(m);
        } catch (err) {
            console.warn(err);
            toast('장소를 찾지 못했습니다');
        } finally {
            // ★ 이게 없어서 지금 계속 켜져 있었던 거
            loadingOff();
        }
    });
}

// 전역 한 번만 선언
let __lastPlaceLL = null;

/** 장소/주소 문자열을 lat,lng로 해석 */
async function resolvePlaceLL(query) {
    await new Promise(r => {
        // Kakao SDK 로딩 보장
        if (window.kakao?.maps?.load) return kakao.maps.load(r);
        const t = setInterval(() => {
            if (window.kakao?.maps?.load) {
                clearInterval(t);
                kakao.maps.load(r);
            }
        }, 30);
        setTimeout(() => {
            clearInterval(t);
            r();
        }, 3000);
    });

    // 1) 키워드 검색
    try {
        const places = new kakao.maps.services.Places();
        const kw = await new Promise((res, rej) => {
            places.keywordSearch(query, (data, status) => {
                if (status === kakao.maps.services.Status.OK && data?.length) {
                    res(data);
                } else {
                    rej(status);
                }
            }, {
                size: 5
            });
        });
        // 가중치: 카테고리/거리 등 필요하면 여기서 정렬 커스텀 가능
        const top = kw[0];
        return {
            lat: +top.y,
            lng: +top.x,
            name: top.place_name || query,
            addr: top.road_address_name || top.address_name || ""
        };
    } catch {}

    // 2) 주소 지오코딩 폴백
    try {
        const geocoder = new kakao.maps.services.Geocoder();
        const addr = await new Promise((res, rej) => {
            geocoder.addressSearch(query, (data, status) => {
                if (status === kakao.maps.services.Status.OK && data?.length) {
                    res(data);
                } else {
                    rej(status);
                }
            });
        });
        const top = addr[0];
        return {
            lat: +top.y,
            lng: +top.x,
            name: query,
            addr: top.address?.address_name || top.road_address?.address_name || ""
        };
    } catch {}

    return null; // 실패
}

// ===== Place(장소) 모드 전용 상태 =====
let PLACE_GROUPS = null; // [ [title, pins[]], ... ]
let PLACE_GROUP_ACTIVE = null; // 현재 선택된 작품명 (필터링 중이면 string, 아니면 null)

function isPlaceModeData(data) {
    if (data?.mode === 'place') return true;
    const pins = data?.pins || [];
    return pins.some(p => p._work || p.work_title || p.work);
}

function groupPinsByWork(pins) {
    const M = new Map();
    pins.forEach(p => {
        // const k = (p._work || p.work_title || p.work || '기타').trim();
        const k = (p.work_title || p.work || (p.subtitle?.split(' · ')[0]) || '기타').trim();
        if (!M.has(k)) M.set(k, []);
        M.get(k).push(p);
    });
    return [...M.entries()].sort((a, b) => b[1].length - a[1].length);
}

// 좌측(PC) 패널에 작품 그룹 보여주기
function renderPlaceGroups_PC(groups) {
    const box = document.getElementById('panel-results');
    if (!box) return;
    const html = `
      <div class="work-groups">
        ${groups.map(([title, arr], i)=>`
          <div class="group" data-work="${escapeHtml(title)}">
            <div class="label">${i + 1}</div>
            <div class="title">${escapeHtml(title)}</div>
            <div class="meta">${arr.length}곳</div>
          </div>
        `).join('')}
      </div>`;
    box.innerHTML = html;

    if (openMobileCourseIdx != null) {
        const secs = box.querySelectorAll('section.m-course');
        const sec = secs[openMobileCourseIdx];
        if (sec) toggleMobileCoursePanel(sec, box);
    }
    box.onclick = (e) => {
        const g = e.target.closest('.group[data-work]');
        if (!g) return;
        const work = g.dataset.work;
        openPlaceGroup(work);
    };
}

// 모바일 시트에 작품 그룹 보여주기
function renderPlaceGroups_Mobile(groups) {
    const box = document.getElementById('m-results');
    if (!box) return;
    const html = `
      <div class="work-groups">
        ${groups.map(([title, arr], i)=>`
          <div class="group" data-work="${escapeHtml(title)}">
            <div class="label">${i + 1}</div>
            <div class="title">${escapeHtml(title)}</div>
            <div class="meta">${arr.length}곳</div>
          </div>
        `).join('')}
      </div>`;
    box.innerHTML = html;

    // ★ 렌더 후, 이전에 열려있던 섹션 복원
    if (openMobileCourseIdx != null) {
        const secs = box.querySelectorAll('section.m-course');
        const sec = secs[openMobileCourseIdx];
        if (sec) toggleMobileCoursePanel(sec, box);
    }

    box.onclick = (e) => {
        const g = e.target.closest('.group[data-work]');
        if (!g) return;
        const work = g.dataset.work;
        openPlaceGroup(work);
    };
}

// 특정 작품을 열었을 때: 상단에 '← 전체 목록' 바 + 해당 촬영지 리스트 + 지도 핀/줌
function openPlaceGroup(workTitle) {
    PLACE_GROUP_ACTIVE = workTitle;
    const pair = (PLACE_GROUPS || []).find(([t]) => t === workTitle);
    const pins = pair ? pair[1] : [];

    // 상단 backbar + 기존 결과 리스트 템플릿 재사용
    const back = `
      <div class="backbar">
        <button class="ghost" id="placeGroupBack">← 전체 목록</button>
        <b style="margin-left:6px">${escapeHtml(workTitle)}</b>
        <span style="margin-left:6px; color:#2563eb; font-size:12px">${pins.length}곳</span>
      </div>`;

    const pcBox = document.getElementById('panel-results');
    const mBox = document.getElementById('m-results');

    if (pcBox) {
        buildResultsPins(pins); // 기존 리스트 빌더 그대로 사용
        pcBox.innerHTML = back + pcBox.innerHTML;
        pcBox.querySelector('#placeGroupBack').onclick = restorePlaceGroups;
    }
    if (mBox) {
        buildResultsMobilePins(pins); // 모바일 리스트 빌더 그대로 사용
        mBox.innerHTML = back + mBox.innerHTML;
        mBox.querySelector('#placeGroupBack').onclick = restorePlaceGroups;
    }

    // 지도도 해당 핀만 보여주고 맞춰서 확대
    setMarkersForPins(pins, {
        fit: true
    });
}

// 그룹 화면으로 복귀
function restorePlaceGroups() {
    PLACE_GROUP_ACTIVE = null;
    if (PLACE_GROUPS) {
        renderPlaceGroups_PC(PLACE_GROUPS);
        renderPlaceGroups_Mobile(PLACE_GROUPS);
        // 지도는 전체 추천 핀으로
        const allPins = PLACE_GROUPS.flatMap(([_, arr]) => arr);
        setMarkersForPins(allPins, {
            fit: true
        });
    }
}

// 추천 코스 패널(또는 코스 패널)의 이벤트 위임
document.getElementById('panel-courses')?.addEventListener('click', (e) => {
    const placeItem = e.target.closest('.course-places .item[data-id]');
    if (placeItem) {
        e.stopPropagation(); // 헤더 토글로 버블링 방지
        const id = placeItem.dataset.id;
        selectPlace(id, {
            pan: true,
            ping: true,
            keepCourses: true
        });
    }

    // 헤더 토글은 그대로
    const header = e.target.closest('.course-header');
    const expandBtn = e.target.closest('.btn-expand');
    if (header || expandBtn) {
        // toggleCoursePanel(...) 등 기존 열고닫기 로직
    }

    
});

// === [PATCH] 보관함(PC/모바일) 원터치 열기 + 지도 동기화 ===

// 공통: 좌측 패널 탭 전환 유틸 (PC)
function _switchPcTab(tabName) {
  const tabs = document.querySelectorAll('.tabs .tab');
  const panels = {
    results: document.getElementById('panel-results'),
    courses: document.getElementById('panel-courses'),
    mine:    document.getElementById('panel-mine'),
  };
  tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  Object.entries(panels).forEach(([k, el]) => {
    if (!el) return;
    el.style.display = (k === tabName) ? '' : 'none';
  });
}

// === 좌측 패널(검색결과/추천 코스/내 보관함) 공통 클릭 위임 ===
(function bindSidebarRowClicks(){
  const side = document.querySelector('.side');
  if (!side || side.dataset.boundRowClicks) return;

  side.addEventListener('click', (e) => {
    // 실제 버튼/링크 클릭은 여기서 건드리지 않음 (각 버튼 전용 핸들러가 처리)
    if (e.target.closest('button, a')) return;

    // 결과/코스: data-id, 보관함: data-fid
    const itCourse  = e.target.closest('#panel-courses .item[data-id]');
    const itResult  = e.target.closest('#panel-results .item[data-id]');
    const itMine    = e.target.closest('#panel-mine   .item[data-fid]');

    if (itCourse) {
      selectPlace(itCourse.dataset.id,   { pan:true, ping:true });
      return;
    }
    if (itResult) {
      selectPlace(itResult.dataset.id,   { pan:true, ping:true });
      return;
    }
    if (itMine) {
      // 보관함 컨텍스트를 지도에 반영 후 선택
      try { updateMapByContext('mine'); } catch {}
      selectPlace(itMine.dataset.fid,    { pan:true, ping:true });
      return;
    }
  });

  side.dataset.boundRowClicks = '1';
})();


// 공통: 모바일 시트 탭 전환 유틸
function _switchMobileSheetTab(tabName) {
  const tabs = document.querySelectorAll('.sheet-tabs .sheet-tab');
  const lists = {
    results: document.getElementById('m-results'),
    courses: document.getElementById('m-courses'),
    mine:    document.getElementById('m-mine'),
  };
  tabs.forEach(t => t.classList.toggle('active', t.dataset.stab === tabName));
  Object.entries(lists).forEach(([k, el]) => {
    if (!el) return;
    el.style.display = (k === tabName) ? '' : 'none';
  });
}

// 1) PC: “내 보관함” 버튼 → 탭 전환 + 렌더 + 지도 동기화
document.getElementById('btnMyBox')?.addEventListener('click', () => {
  _switchPcTab('mine');             // 좌측 탭 전환
  window.renderMine?.();            // PC 보관함 렌더 (이미 있으시면 사용)
  window.renderMobileMine?.();      // 모바일 렌더도 맞춰서 (데이터 동기화 목적)
  updateMapByContext('mine');       // 지도 컨텍스트 mine
});

// 1) Mobile: “내 보관함” 버튼 → 시트 전환 + 렌더 + 지도 동기화 + 시트 오픈
document.getElementById('mMyBox')?.addEventListener('click', () => {
  _switchMobileSheetTab('mine');    // 모바일 시트 탭 전환
  window.renderMobileMine?.();      // 모바일 보관함 렌더
  updateMapByContext('mine');       // 지도 컨텍스트 mine
  // 시트 65% 오픈(필요하면 조정)
  if (typeof window.openSheetToPercent === 'function') {
    window.openSheetToPercent(0.62);
  }
});

// 2) 모바일 시트 탭을 사용자가 직접 눌러도 지도 컨텍스트 동기화
document.querySelectorAll('.sheet-tabs .sheet-tab')?.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.getAttribute('data-stab');
    _switchMobileSheetTab(target);
    if (target === 'mine') {
      window.renderMobileMine?.();
    }
    updateMapByContext(target);
  });
});

// 3) 로그인 상태 변화 후 보관함 갱신 진입점 (예: 로그인/로그아웃 완료 시 호출)
window.refreshMineUI = function() {
  const activePc = document.querySelector('.tabs .tab.active')?.dataset.tab;
  const activeMo = document.querySelector('.sheet-tabs .sheet-tab.active')?.dataset.stab;
  if (activePc === 'mine' || activeMo === 'mine') {
    window.renderMobileMine?.();
    window.renderMine?.(); // PC 렌더가 있으면 동기
    updateMapByContext('mine');
    highlightMineItemById(placeId);
    return; // 나머지 결과탭 하이라이트/전환 로직은 실행하지 않음
  }
};

// === Mine 하이라이트 유틸 ===
window.highlightMineItemById = function(fid, opts = { smooth: true, press: true }) {
  const wrap = document.getElementById('m-mine');
  if (!wrap) return;

  // 기존 active 제거
  wrap.querySelectorAll('.item.active').forEach(n => n.classList.remove('active'));

  // 보관함 렌더는 일반적으로 data-fid를 사용합니다.
  // 혹시 템플릿에 따라 data-id만 있는 경우도 대비해서 둘 다 조회
  const it = wrap.querySelector(`.item[data-fid="${fid}"], .item[data-id="${fid}"]`);
  if (!it) return;

  // active 부여 + 스크롤
  it.classList.add('active');
  try {
    it.scrollIntoView({ behavior: opts.smooth ? 'smooth' : 'auto', block: 'center' });
  } catch { it.scrollIntoView(); }

  // 눌림(pressed) 피드백(짧게)
  if (opts.press) {
    it.classList.add('pressed');
    setTimeout(() => it.classList.remove('pressed'), 500);
  }

  // 시트가 닫혀 있으면 열어주기 + 높이 보정
  if (typeof window.ensureMobileSheetOpen === 'function') ensureMobileSheetOpen('mine');
  if (typeof window.openSheetToPercent === 'function') openSheetToPercent(0.62);
};

// === 지도 센터 보정: 좌측 리스트가 가리는 폭만큼 우측으로 밀기 ===
function panBiasForLeftUI(mapElSelector = '#panel-results', padding = 16) {
  const mapEl = document.getElementById('map');
  const uiEl  = document.querySelector(mapElSelector);
  if (!mapEl || !uiEl) return 0;

  const mr = mapEl.getBoundingClientRect();
  const ur = uiEl.getBoundingClientRect();

  // 지도와 좌측 패널이 실제로 겹치는 픽셀 너비
  const overlapLeft  = Math.max(mr.left, ur.left);
  const overlapRight = Math.min(mr.right, ur.right);
  const overlapW = Math.max(0, overlapRight - overlapLeft);

  // 너무 많이 밀리지 않도록 (겹친 폭 + 여백)의 절반만 이동
  const dx = Math.round((overlapW + padding) / 2);
  return dx > 0 ? dx : 0;
}


// === [Sheet Hold] 탭/아이템 클릭 직후 자동 스냅(닫힘) 차단 + 높이 유지 ===
window._sheetHoldUntil = 0;
window.keepSheetOpen = function(min = 0.62, ms = 450){
  try { openSheetToPercent?.(min); } catch {}
  window._sheetHoldUntil = Date.now() + ms; // 이 시간 동안은 자동닫힘 무시
};

// (선택) ensureMobileSheetOpen이 undefined면 기본 구현 제공
if (typeof window.ensureMobileSheetOpen !== 'function') {
  window.ensureMobileSheetOpen = (/*stab*/) => openSheetToPercent?.(0.62);
}

// 2-1) 탭 클릭 시: 항상 중간 이상 열린 상태 유지
document.querySelectorAll('.sheet-tabs .sheet-tab').forEach(tab=>{
  tab.addEventListener('click', ()=>{
    window.keepSheetOpen(0.62, 450);
  }); // ← capture 제거, preventDefault/stopPropagation 제거
});
// 2-2) 리스트 아이템 클릭 시: 시트 유지 + 살짝 눌린 피드백(선택)
document.getElementById('sheet')?.addEventListener('click', (ev)=>{
  const it = ev.target.closest('.item');
  if (!it) return;
  window.keepSheetOpen(0.62, 450);
}, {capture:true});

// 2-3) (선택) 시트 핸들에만 드래그 허용: 탭/아이템은 미세 이동 무시
(function reduceTapToDragMisfire(){
  const sheet = document.getElementById('sheet');
  if (!sheet) return;

  let downY=0, moved=false, downAt=0;
  const TAP_MS=220, TAP_MOVE=10;

  sheet.addEventListener('pointerdown', e=>{
    if (e.pointerType!=='touch' && e.pointerType!=='pen') return;
    downY = e.clientY; moved=false; downAt=Date.now();
  }, {passive:true});

  sheet.addEventListener('pointermove', e=>{
    if (!downAt) return;
    if (Math.abs(e.clientY - downY) > TAP_MOVE) moved=true;
  }, {passive:true});

  sheet.addEventListener('pointerup', e=>{
    const isTap = (Date.now()-downAt) < TAP_MS && !moved;
    downAt=0;
    if (isTap){
      // 탭/아이템 ‘탭’을 드래그로 오인해 스냅하지 않도록 홀드
      window.keepSheetOpen(0.62, 450);
    }
  }, {passive:false});
})();

// === [FIX] PC 전용: 좌측 리스트 클릭이 누락되는 경우를 위한 안전 브리지 ===
// - 기존 box.onclick 위임이 덮여도 동작 보장
// - 버튼/입력요소 클릭은 가로채지 않음
// - 모바일은 기존 로직 유지
// === [PATCH] PC 좌측 패널 휠 스크롤 강제 보장 ===
(function ensureSideWheelScroll(){
  try{
    const side = document.querySelector('aside.side');
    if (!side || side.dataset.wheelBound === '1') return;

    const getScroller = (startEl) => {
      const c1 = startEl?.closest?.('.results');
      if (c1) return c1;
      const c2 = startEl?.closest?.('#panel-results, #panel-courses, #panel-mine');
      if (c2) return c2;
      return side.querySelector('#panel-mine') 
          || side.querySelector('#panel-results') 
          || side.querySelector('#panel-courses');
    };

    const onWheel = (e) => {
      const scroller = getScroller(e.target);
      if (!scroller) return;
      const before = scroller.scrollTop;
      scroller.scrollTop += e.deltaY;    // 휠량만큼 강제 스크롤
      const after = scroller.scrollTop;
      if (before !== after) e.preventDefault(); // 실제 스크롤이 됐으면 맵/배경으로 전파 막음
    };

    side.addEventListener('wheel', onWheel, { capture: true, passive: false });
    side.dataset.wheelBound = '1';
  }catch{}
})();

// === [MOVE-DEL] 보관함 항목에 삭제버튼 보장 + 삭제 동작 위임(PC 전용 동작) ===
(function ensureMineDeleteButton(){
  const mine = document.getElementById('panel-mine');
  if (!mine || mine.dataset.mineDelBound === '1') return;

  // 보관함 아이템마다 삭제 버튼이 없으면 주입
  const ensureBtn = (row) => {
    // if (!row || row.querySelector('.btn-fav-del,[data-action="fav-del"]')) return;
    // const btn = document.createElement('button');
    // btn.type = 'button';
    // btn.className = 'btn-fav-del';
    // btn.setAttribute('data-action','fav-del');
    // btn.textContent = '삭제';
    // 아이템 안에 meta 영역이 있으면 거기에, 없으면 아이템 끝에 달기
    const mount = row.querySelector('.meta') || row;
    // mount.appendChild(btn);
  };

  // 초기 한번 채우기
  mine.querySelectorAll('.item[data-fid], .item[data-id]').forEach(ensureBtn);

  // 동적 추가 대응
  const mo = new MutationObserver((muts)=>{
    muts.forEach(m=>{
      m.addedNodes.forEach(n=>{
        if (n.nodeType !== 1) return;
        if (n.matches?.('.item[data-fid], .item[data-id]')) ensureBtn(n);
        n.querySelectorAll?.('.item[data-fid], .item[data-id]').forEach(ensureBtn);
      });
    });
  });
  mo.observe(mine, { childList: true, subtree: true });

  // 삭제 클릭 위임
  mine.addEventListener('click', async (e) => {
    // "즐겨찾기 삭제" 버튼 처리
        const btnDelete = e.target.closest('.btn-fav-del,[data-action="fav-del"]');
        if (btnDelete) {
            e.stopPropagation();
            e.preventDefault();

            const row = btnDelete.closest('.item[data-fid], .item[data-id]');    
            const id = row?.dataset.fid || row?.dataset.id;
            if (!id) return;
            if (!confirm('이 장소를 보관함에서 삭제할까요?')) return;
            const ok = await deleteFavoriteById(id);
            if (ok) {
                loadMyBox();  // 리스트 갱신
                updateMapByContext('mine');  // 보관함 기준으로 지도 갱신
                if (activePlaceId === id) { 
                    try { 
                        infoWin?.close(); 
                    } catch {} 
                    activePlaceId = null; 
                }
            }
        }

        // "코스 담기" 버튼 처리
        const btnAddToCourse = e.target.closest('.btn-to-course');
        if (btnAddToCourse) {
            e.stopPropagation();
            e.preventDefault();

            const row = btnAddToCourse.closest('.item[data-fid], .item[data-id]');    
            const id = row?.dataset.fid || row?.dataset.id;
            const lat = +row?.dataset.lat;
            const lng = +row?.dataset.lng;
            const title = row?.querySelector('.title')?.textContent;
            const addr = row?.querySelector('.addr')?.textContent;

            // 코스 만들기 상태 확인
            if (!courseDraft) {
                toast('하단 "+ 버튼"을 먼저 누르고 코스를 추가하세요');
                return;
            }

            // 이미 담긴 장소인지 확인
            if (!courseDraft.spots.find(spot => spot.id === id)) {
                // 장소를 코스에 추가
                courseDraft.spots.push({
                    id,
                    title,
                    subtitle: addr,
                    lat,
                    lng
                });
                toast('코스에 담겼어요');
            } else {
                toast('이미 담긴 장소입니다');
            }
        }
    }, true);


  mine.dataset.mineDelBound = '1';
})();


// 2025 09 10 이후 추가 함수

// ===== Favorite order (local) =====

/* =========================================================
 * ① 즐겨찾기 UI 반영 (별/삭제 버튼/투어카드) — upsert/delete에서 사용
 * ========================================================= */
function reflectFavoriteUI(id, isFav) {
  // PC 결과
  document.querySelectorAll(`#panel-results .item[data-id="${id}"]`).forEach(row => {
    const favEl = row.querySelector('.btn-fav');
    if (favEl) favEl.textContent = isFav ? '★' : '☆';
    const rm = row.querySelector('.btn-remove');
    if (rm) rm.style.display = isFav ? 'inline-flex' : 'none';
  });

  // 모바일 결과
  document.querySelectorAll(`#m-results .item[data-id="${id}"]`).forEach(row => {
    const favEl = row.querySelector('.btn-fav');
    if (favEl) favEl.textContent = isFav ? '★' : '☆';
    const rm = row.querySelector('.btn-remove');
    if (rm) rm.style.display = isFav ? 'inline-flex' : 'none';
  });

  // Tour 레이어 (data-fid)
  document.querySelectorAll(`[data-fid="${id}"] .btn-fav`).forEach(btn => {
    btn.textContent = isFav ? '★' : '☆';
  });
}

/* =========================================================
 * ② 로컬 순서 저장/적용 — 서버가 있으면 함께 반영
 * ========================================================= */
function _favOrderKey() {
  const u = (auth?.user?.username || 'guest');
  return `favOrder:${u}`;
}
function readFavOrder() {
  try { return JSON.parse(localStorage.getItem(_favOrderKey()) || '[]'); } catch { return []; }
}
function writeFavOrder(ids) {
  try { localStorage.setItem(_favOrderKey(), JSON.stringify(ids)); } catch {}
}
async function setFavOrder(orderIds = []) {
  writeFavOrder(orderIds);
  // 서버에 엔드포인트가 있으면 시도(없어도 에러 무시)
  try {
    await reqJSON('/api/user/favorites/order', {
      method: 'POST',
      body: JSON.stringify({ order: orderIds })
    });
  } catch {}
}
function applyFavOrderLocally(items = []) {
  const order = readFavOrder();
  if (!order?.length) return items;
  const pos = Object.fromEntries(order.map((id, i) => [id, i]));
  items.sort((a, b) => {
    const ai = (pos[a.id] ?? 1e9), bi = (pos[b.id] ?? 1e9);
    return ai - bi;
  });
  return items;
}

/* =========================================================
 * ③ 번호 라벨 재부여 + 미리보기 라인 정리
 * ========================================================= */
function renumberFavList() {
  const list = document.querySelector('#panel-mine #favList');
  if (!list) return;
  [...list.querySelectorAll('.item[data-fid] .label')].forEach((lb, i) => lb.textContent = i + 1);
}

/* =========================================================
 * ④ 드래그 핸들 보강 — 렌더 템플릿에 없을 때 자동 주입
 * ========================================================= */
function ensureDndHandlePresent() {
  const list = document.querySelector('#panel-mine #favList');
  if (!list) return;
  list.querySelectorAll('.item[data-fid]').forEach(row => {
    if (!row.querySelector('.dnd-handle')) {
      const h = document.createElement('div');
      h.className = 'dnd-handle';
      h.setAttribute('title','드래그로 순서 바꾸기');
      h.setAttribute('draggable','true');
      h.textContent = '↕';
      row.insertBefore(h, row.firstChild);
    }
  });
}

/* =========================================================
 * ⑤ DnD 정렬 본체 — 지도 연결 순서/미리보기/서버 동기화
 * ========================================================= */
function makeFavListSortable() {
  const list = document.querySelector('#panel-mine #favList');
  if (!list) return;

  let draggingRow = null;

  // 핸들만 드래그 가능하게
  list.querySelectorAll('.item[data-fid]').forEach(it => it.removeAttribute('draggable'));
  list.querySelectorAll('.item .dnd-handle').forEach(h => h.setAttribute('draggable','true'));

  list.addEventListener('dragstart', (e) => {
    const handle = e.target.closest('.dnd-handle');
    if (!handle) return;
    draggingRow = handle.closest('.item[data-fid]');
    if (!draggingRow) return;
    _favDragging = true;
    draggingRow.classList.add('dragging');
    e.dataTransfer?.setData('text/plain', draggingRow.dataset.fid);
    e.dataTransfer?.setDragImage?.(draggingRow, 10, 10);
  }, true);

  list.addEventListener('dragover', (e) => {
    if (!draggingRow) return;
    e.preventDefault();

    const rows = [...list.querySelectorAll('.item[data-fid]:not(.dragging)')];
    const before = rows.find(r => {
      const rect = r.getBoundingClientRect();
      return e.clientY < rect.top + rect.height / 2;
    });
    if (before) list.insertBefore(draggingRow, before);
    else list.appendChild(draggingRow);

    // 드래그 중 점선 라인 미리보기
    const orderIds = [...list.querySelectorAll('.item[data-fid]')].map(el => el.dataset.fid);
    updateMineRoutePreviewByOrderIds(orderIds);
  });

  function done() {
    if (!draggingRow) return;
    draggingRow.classList.remove('dragging');
    draggingRow = null;
    _favDragging = false;

    const orderIds = [...list.querySelectorAll('.item[data-fid]')].map(el => el.dataset.fid);
    setFavOrder(orderIds);
    // window.myFavItems도 같은 순서로 정렬
    if (Array.isArray(window.myFavItems)) {
      const pos = Object.fromEntries(orderIds.map((id, i) => [id, i]));
      window.myFavItems.sort((a, b) => (pos[a.id] ?? 1e9) - (pos[b.id] ?? 1e9));
    }
    renumberFavList();

    // 미리보기 라인 제거 + 실제 경로 다시 그림
    try { mineRoutePreview?.setMap?.(null); mineRoutePreview = null; } catch {}
    updateMapByContext('mine');
  }

  list.addEventListener('drop', (e) => { e.preventDefault(); done(); });
  list.addEventListener('dragend', () => done());
}


function saveFavOrder(orderIds = []) {
  try { localStorage.setItem(_favOrderKey(), JSON.stringify(orderIds)); } catch {}
}


// 리스트 DOM 순서를 읽어 id 배열로 반환
function getFavOrderFromDOM(listEl) {
  return Array.from(listEl.querySelectorAll('.item[data-fid]')).map(n => n.dataset.fid);
}

//번역

// 보이는 텍스트만 수집 + 중복 제거 → 한 번 호출
async function translatePageFast(to='en') {
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','CODE','PRE','TEXTAREA','INPUT','SELECT','OPTION','IFRAME','SVG']);
  const originalMap = new WeakMap();

  const isVisible = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    return cs && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  };

  // 1) 텍스트 노드 수집(가시 노드만)
  const nodes=[];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p || SKIP.has(p.tagName) || !isVisible(p)) return NodeFilter.FILTER_REJECT;
      const s = (node.nodeValue||'').trim();
      if (!s || /^[0-9\s.,:;!?()\-+*/]+$/.test(s)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let n; while ((n=w.nextNode())) nodes.push(n);
  if (!nodes.length) return;

  // 2) 중복 제거
  const texts = nodes.map(nd => nd.nodeValue);
  const uniq = [...new Set(texts)];

  // 3) 서버에 일괄 요청(한 번)
  const res = await reqJSON('/api/translate', {
    method: 'POST',
    body: JSON.stringify({ to, texts: uniq })
  });
  const dict = new Map(uniq.map((u,i)=>[u, res.translations[i]]));

  // 4) 적용(원문 백업)
  nodes.forEach(nd => {
    if (!originalMap.has(nd)) originalMap.set(nd, nd.nodeValue);
    const t = dict.get(nd.nodeValue);
    if (t) nd.nodeValue = t;
  });

  toast('번역 완료');
}

// 예: <button id="btnTranslateEn">EN</button>
// document.getElementById('btnTranslateEn')
//   ?.addEventListener('click', () => translatePageFast('en'));
// 버튼 클릭으로 한↔영 토글
on('btnTranslateToggle', 'click', async (ev) => {
  const btn = ev.currentTarget;
  try {
    btn.classList.add('busy'); // 로딩 회전
    if (window.I18N?.state === 'ko') {
      await translateToEN();                 // KO -> EN
      btn.setAttribute('aria-pressed', 'true');
      btn.title = '한국어로 복원';
    } else {
      restoreKO();                           // EN -> KO
      btn.setAttribute('aria-pressed', 'false');
      btn.title = '영어로 번역';
    }
  } catch (e) {
    console.warn(e);
    toast('번역 처리 중 오류');
  } finally {
    btn.classList.remove('busy');
  }
});


function collectTextNodes({onlyVisible=true, onlyHangul=true} = {}) {
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','CODE','PRE','TEXTAREA','INPUT','SELECT','OPTION','IFRAME','SVG']);
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    // 화면 안쪽(조금 버퍼)만 우선
    return r.bottom > -100 && r.top < vh + 10000;
  };
  const hasHangul = (s) => /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/.test(s);

  const nodes = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(nd) {
      const p = nd.parentElement;
      if (!p || SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      const s = (nd.nodeValue||'').trim();
      if (!s) return NodeFilter.FILTER_REJECT;
      if (onlyHangul && !hasHangul(s)) return NodeFilter.FILTER_REJECT;
      if (onlyVisible && !isVisible(p)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let n; while ((n=w.nextNode())) nodes.push(n);
  return nodes;
}

async function translatePageFast(to='en') {
  // 1) 1차: 뷰포트 우선
  await translateNodesBatch(collectTextNodes({onlyVisible:true}));

  // 2) 2차: 나머지는 스크롤될 때 지연 번역
  lazyTranslateRest(to);
}

async function translateNodesBatch(nodes, to='en') {
  if (!nodes.length) return;
  const texts = nodes.map(nd => nd.nodeValue);
  const uniq = [...new Set(texts)];
  const res = await reqJSON('/api/translate', { method:'POST', body: JSON.stringify({ to, texts: uniq })});
  const dict = new Map(uniq.map((u,i)=>[u, res.translations[i] || u]));
  nodes.forEach(nd => { const t = dict.get(nd.nodeValue); if (t) nd.nodeValue = t; });
}

function lazyTranslateRest(to='en') {
  const pending = collectTextNodes({onlyVisible:false});     // 전체
  const visibleSet = new Set(collectTextNodes({onlyVisible:true}).map(n=>n));
  const rest = pending.filter(n => !visibleSet.has(n));
  if (!rest.length) return;

  const BATCH = 100;
  let bucket = new Set();

  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        const node = [...e.target.childNodes].find(n => n.nodeType===Node.TEXT_NODE);
        if (node) { bucket.add(node); if (bucket.size >= BATCH) flush(); }
        io.unobserve(e.target);
      }
    });
  }, { root: null, rootMargin: '200px 0px' });

  rest.forEach(nd => nd.parentElement && io.observe(nd.parentElement));

  async function flush() {
    const nodes = Array.from(bucket); bucket.clear();
    try { await translateNodesBatch(nodes, to); } catch {}
  }

  // 안전망: 끝까지 스크롤 안 해도 일정 시간 후 잔여 처리
  setTimeout(() => { if (bucket.size) flush(); }, 300);
}

// 번역 함수 되돌리기 추가

// ===== i18n 토글 전역 상태 =====
window.I18N = {
  state: 'ko',                 // 'ko' | 'en' (현재 화면 언어)
  orig: new WeakMap(),         // TextNode -> 원문(한국어)
  cache: new Map(),            // `${to}|${src}` -> 번역문
};

function _hasHangul(s){ return /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/.test(s); }

// 화면의 "보이는" 텍스트 노드 수집
function _collectTextNodes({ onlyVisible=true, onlyHangul=true } = {}) {
  const SKIP = new Set(['SCRIPT','STYLE','NOSCRIPT','CODE','PRE','TEXTAREA','INPUT','SELECT','OPTION','IFRAME','SVG','CANVAS']);
  const isVisible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    if (!onlyVisible) return true;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return r.bottom > -120 && r.top < vh + 240; // 살짝 버퍼
  };
  const nodes = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(nd) {
      const p = nd.parentElement;
      if (!p || SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
      const s = (nd.nodeValue || '').trim();
      if (!s) return NodeFilter.FILTER_REJECT;
      if (onlyHangul && !_hasHangul(s)) return NodeFilter.FILTER_REJECT;
      if (!isVisible(p)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let n; while ((n = w.nextNode())) nodes.push(n);
  return nodes;
}

// 서버 일괄 번역 호출(중복 제거 + 한 번에)
async function _bulkTranslate(texts, to='en') {
  const uniq = [...new Set(texts)];
  const misses = uniq.filter(u => !I18N.cache.has(`${to}|${u}`));
  if (misses.length) {
    const res = await reqJSON('/api/translate', {
      method: 'POST',
      body: JSON.stringify({ to, texts: misses })
    });
    (misses).forEach((src, i) => {
      const dst = res?.translations?.[i] ?? src;
      I18N.cache.set(`${to}|${src}`, dst);
    });
  }
  return uniq.map(u => I18N.cache.get(`${to}|${u}`) || u);
}

// EN으로 번역(보이는 영역 우선 → 나머지 지연 처리)
async function translateToEN() {
  // 1) 1차: 뷰포트 안 보이는 텍스트 우선
  const nodes = _collectTextNodes({ onlyVisible:true,  onlyHangul:true });
  if (!nodes.length) { toast('번역할 텍스트가 없습니다'); return; }

  const texts = nodes.map(n => n.nodeValue);
  await _bulkTranslate(texts, 'en');

  nodes.forEach(n => {
    if (!I18N.orig.has(n)) I18N.orig.set(n, n.nodeValue);  // 원문 백업
    const t = I18N.cache.get(`en|${n.nodeValue}`) || n.nodeValue;
    n.nodeValue = t;
  });
  I18N.state = 'en';
  toast('영어 번역 적용');

  // 2) 2차: 나머지는 스크롤 시 지연 번역
  _lazyTranslateRest('en');
}

// 지연 번역(보이지 않던 텍스트는 스크롤될 때 소량씩 번역)
function _lazyTranslateRest(to='en') {
  const all   = _collectTextNodes({ onlyVisible:false, onlyHangul:true });
  const first = new Set(_collectTextNodes({ onlyVisible:true, onlyHangul:true }));
  const rest  = all.filter(n => !first.has(n));
  if (!rest.length) return;

  const BATCH = 60;
  let bucket = new Set();
  const io = new IntersectionObserver(async (entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const node = [...e.target.childNodes].find(x => x.nodeType === Node.TEXT_NODE && _hasHangul((x.nodeValue||'').trim()));
      if (!node) { io.unobserve(e.target); continue; }
      bucket.add(node);
      if (bucket.size >= BATCH) { await _flush(); }
      io.unobserve(e.target);
    }
  }, { root:null, rootMargin:'240px 0px' });

  rest.forEach(n => n.parentElement && io.observe(n.parentElement));

  async function _flush() {
    const list = Array.from(bucket); bucket.clear();
    const texts = list.map(n => n.nodeValue);
    await _bulkTranslate(texts, to);
    list.forEach(n => {
      if (!I18N.orig.has(n)) I18N.orig.set(n, n.nodeValue);
      const t = I18N.cache.get(`${to}|${n.nodeValue}`) || n.nodeValue;
      n.nodeValue = t;
    });
  }

  // 안전망: 일정 시간 뒤 남은 것 처리
  setTimeout(() => { if (bucket.size) _flush(); }, 300);
}

// 한국어로 되돌리기(복원)
function restoreKO() {
  const nodes = _collectTextNodes({ onlyVisible:false, onlyHangul:false });
  let restored = 0;
  nodes.forEach(n => {
    const orig = I18N.orig.get(n);
    if (typeof orig === 'string') { n.nodeValue = orig; restored++; }
  });
  I18N.state = 'ko';
  toast(restored ? '원문(한국어)으로 복원' : '복원할 항목이 없습니다');
}


(function bootFromQueryOrStorage(){
    // 1) URL 우선
    const sp = new URLSearchParams(location.search || "");
    let payload = null;

    if ([...sp.keys()].length) {
      const mode =
        sp.get('mode') || sp.get('type') || sp.get('target') || 'drama';
      const keyword =
        sp.get('kw') || sp.get('q') || sp.get('keyword') || sp.get('name') || '';
      const updRaw = sp.get('update') || sp.get('refresh') || sp.get('u');
      const willUpdate = (updRaw === '1' || (updRaw || '').toLowerCase() === 'true');

      if (keyword) payload = { mode, keyword, willUpdate };
    }

    // 2) 없으면 sessionStorage(deepSearch) 백업
    if (!payload) {
      try {
        const raw = sessionStorage.getItem('deepSearch');
        if (raw) {
          sessionStorage.removeItem('deepSearch'); // 재실행 방지
          const { mode='drama', keyword='', willUpdate=false } = JSON.parse(raw) || {};
          if (keyword) payload = { mode, keyword, willUpdate };
        }
      } catch (e) { console.warn('bootFromQueryOrStorage:', e); }
    }

    if (!payload) return;

    const isMobile = window.matchMedia('(max-width: 900px)').matches;

    if (isMobile) {
      const mMode = document.querySelector('#mMode');
      const mKw   = document.querySelector('#mKeyword');
      const mUpd  = document.querySelector('#mDoRefresh');
      const mGo   = document.querySelector('#mGo');
      if (mMode && mKw && mGo) {
        mMode.value = payload.mode;
        mKw.value   = payload.keyword;
        if (mUpd) mUpd.checked = !!payload.willUpdate;
        mGo.click(); // ← app.js의 모바일 검색 핸들러가 실행됩니다
      }
    } else {
      const modeEl = document.querySelector('#mode');
      const kwEl   = document.querySelector('#keyword');
      const updEl  = document.querySelector('#doRefresh');
      const goBtn  = document.querySelector('#go');
      if (modeEl && kwEl && goBtn) {
        modeEl.value = payload.mode;
        kwEl.value   = payload.keyword;
        if (updEl) updEl.checked = !!payload.willUpdate;
        goBtn.click(); // ← app.js의 데스크톱 검색 핸들러가 실행됩니다
      }
    }
  })();


// 드래그 이벤트 처리 함수 수정
function handleDragStart(event) {
    event.dataTransfer.setData("text/plain", event.target.dataset.index);
}

function handleDrop(event) {
    event.preventDefault();
    const draggedIndex = event.dataTransfer.getData("text/plain");
    const targetIndex = event.target.dataset.index;

    if (draggedIndex !== targetIndex) {
        // 실제 순서 변경
        reorderCourseSpots(draggedIndex, targetIndex);
    }
}

// 드래그 이벤트 초기화
function initDragEvents() {
    const courseItems = document.querySelectorAll('.course-item');
    courseItems.forEach(item => {
        item.addEventListener('dragstart', handleDragStart);
        item.addEventListener('drop', handleDrop);
    });
}

// 순서 업데이트 함수 수정
function reorderCourseSpots(draggedIndex, targetIndex) {
    // 배열의 유효한 인덱스인지 확인
    if (draggedIndex < 0 || draggedIndex >= window.mySavedCourses.length || 
        targetIndex < 0 || targetIndex >= window.mySavedCourses.length) {
        console.error('Invalid index:', draggedIndex, targetIndex);
        return; // 유효하지 않은 인덱스는 함수 종료
    }

    const course = window.mySavedCourses[draggedIndex];

    // Ensure the course is valid before attempting to reorder
    if (!course || typeof course !== 'object' || !course.id) {
        console.error(`Invalid course at index ${draggedIndex}:`, course);
        return; // Skip this operation if the course is invalid
    }

    // Proceed with reordering if the course is valid
    window.mySavedCourses.splice(draggedIndex, 1);  // draggedIndex에서 항목을 제거
    window.mySavedCourses.splice(targetIndex, 0, course);  // targetIndex에 항목을 삽입

    // Update UI after reordering
    renderCourses(window.mySavedCourses);
}


// UI를 갱신하는 함수
function renderCourses(courses) {
    const validCourses = courses.filter(course => course && typeof course === 'object' && course.id);
    
    if (validCourses.length === 0) {
        console.error('No valid courses to render');
        return; // 유효한 코스가 없으면 종료
    }
    console.log('Rendering courses:', courses);
    const courseContainer = document.getElementById('panel-courses');
    courseContainer.innerHTML = ''; // 기존 콘텐츠 초기화
    console.log('Dragged index:', draggedIndex);
    console.log('Target index:', targetIndex);
    console.log('Course to reorder:', course);

    courses.forEach((course, index) => {
        if (!course || !course.name) {
            console.error(`Invalid course at index ${index}`, course);
            return;  // course가 유효하지 않으면 건너뛰기
        }

        const courseItem = document.createElement('div');
        courseItem.classList.add('course-item');
        courseItem.dataset.index = index; // 각 아이템에 순서(index) 설정
        courseItem.setAttribute('draggable', true);
        courseItem.innerHTML = `
            <div class="course-name">${course.name}</div>
            <div class="course-description">${course.description || 'No description available'}</div>
        `;
        courseContainer.appendChild(courseItem);
    });

    initDragEvents();  // 드래그 이벤트 초기화
}

