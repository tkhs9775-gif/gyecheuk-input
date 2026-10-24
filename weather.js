// 현장 이름에서 지역(○○동·읍·면·리)을 뽑아 그 지역의 날씨를 보여 준다.
// 위치 찾기는 OpenStreetMap(Nominatim), 날씨는 Open-Meteo. 둘 다 키가 필요 없고 브라우저에서 바로 부른다.
// 이 파일은 app.js보다 먼저 읽히므로, 화면 요소($)와 state는 함수가 불릴 때만 쓴다.

const WEATHER_TTL_MS = 30 * 60 * 1000;
const WEATHER_TIMEOUT_MS = 15 * 1000;   // 신호가 약하면 '불러오는 중'에 묶이지 않고 안내로 바뀐다
const PLACE_TOKEN = /^[가-힣0-9]+(?:동|읍|면|리)$/;
const WEATHER_TEXT = [
  [[0], '☀ 맑음'], [[1, 2], '🌤 구름 조금'], [[3], '☁ 흐림'], [[45, 48], '🌫 안개'],
  [[51, 53, 55, 56, 57], '🌦 이슬비'], [[61, 63, 65, 66, 67], '🌧 비'], [[71, 73, 75, 77], '❄ 눈'],
  [[80, 81, 82], '🌦 소나기'], [[85, 86], '❄ 눈 소나기'], [[95, 96, 99], '⛈ 뇌우'],
];
const weatherCache = {};   // 지역 이름 → { at, data }

// "당산동 신축공사 계측용역현장" → "당산동". 동·읍·면·리로 끝나는 첫 낱말을 쓰고, 없으면 ''
function siteToPlace(siteName) {
  return String(siteName ?? '').split(/[\s,()·_\-/]+/).find((t) => PLACE_TOKEN.test(t)) ?? '';
}

function weatherText(code) {
  const hit = WEATHER_TEXT.find(([codes]) => codes.includes(code));
  return hit ? hit[1] : '날씨 정보';
}

const rain = (mm) => `${Number(mm ?? 0).toFixed(1).replace(/\.0$/, '')}mm`;

// 기록 칸에 붙이는 한 줄 (80자 이내)
function weatherLine(w) {
  return `${weatherText(w.code)} ${w.temp}°C · 오늘 강수 ${rain(w.today)} · 어제 강수 ${rain(w.yesterday)}`;
}

// 이 폰에서 지역을 직접 고쳐 둔 게 있으면 그것을 먼저 쓴다
const placeKeyword = (siteName) => store.get(`place:${siteName}`) || siteToPlace(siteName);

// 두 외부 서비스 공통: 시간 제한을 두고 JSON만 받는다(HTML 오류 페이지는 실패로 본다)
async function fetchJson(url, what) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), WEATHER_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error(`${what} 응답 오류 ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function geocode(keyword) {
  const saved = store.get(`geo:${keyword}`);
  if (saved) { try { return JSON.parse(saved); } catch { /* 깨졌으면 다시 찾는다 */ } }
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(keyword)}&format=json&countrycodes=kr&limit=1&accept-language=ko`;
  const [hit] = await fetchJson(url, '위치 찾기');
  if (!hit) return null;
  const parts = String(hit.display_name ?? '').split(',').map((s) => s.trim()).filter((s) => s && !/^\d+$/.test(s) && s !== '대한민국');
  const label = [...new Set([parts.at(-1), parts.at(-2), parts[0]])].filter(Boolean).join(' ') || keyword;
  const place = { lat: Number(hit.lat), lon: Number(hit.lon), label };
  if (!Number.isFinite(place.lat) || !Number.isFinite(place.lon)) return null;
  store.set(`geo:${keyword}`, JSON.stringify(place));
  return place;
}

async function fetchWeather(place) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}`
    + '&current=temperature_2m,weather_code&daily=precipitation_sum&past_days=1&forecast_days=1&timezone=Asia%2FSeoul';
  const d = await fetchJson(url, '날씨');
  const [yesterday, today] = d.daily.precipitation_sum;
  return { temp: d.current.temperature_2m, code: d.current.weather_code, today, yesterday };
}

function paintWeather(main, sub) {
  show($('weather'), true);
  show($('weatherLine'), true);
  $('weatherMain').textContent = main;
  $('weatherSub').textContent = sub;
  $('weatherLine').textContent = sub ? `${main} · ${sub}` : main;
}

// 현재 현장의 날씨를 화면에 그린다. 실패해도 입력은 막지 않는다
async function refreshWeather() {
  const site = state.site;
  state.weather = null;
  if (!site) { show($('weather'), false); show($('weatherLine'), false); return; }
  const keyword = placeKeyword(site);
  if (!keyword) { paintWeather('날씨', '현장 이름에 ○○동이 없습니다. 눌러서 지역을 입력하세요.'); return; }
  paintWeather(`${keyword} 날씨`, '불러오는 중...');
  try {
    const cached = weatherCache[keyword];
    let data = cached && Date.now() - cached.at < WEATHER_TTL_MS ? cached.data : null;
    if (!data) {
      const place = await geocode(keyword);
      if (!place) {
        if (site === state.site) paintWeather(`${keyword} 날씨`, '지역을 찾지 못했습니다. 눌러서 다른 이름으로 입력하세요.');
        return;
      }
      data = { place, w: await fetchWeather(place) };
      weatherCache[keyword] = { at: Date.now(), data };
    }
    if (site !== state.site) return; // 그 사이 다른 현장을 골랐다
    state.weather = { record: weatherLine(data.w) };
    paintWeather(`${weatherText(data.w.code)} ${data.w.temp}°C`, `${data.place.label} · 오늘 강수 ${rain(data.w.today)} · 어제 강수 ${rain(data.w.yesterday)}`);
  } catch (err) {
    console.warn('날씨 조회 실패', err);   // 날씨는 덤: 사용자에게는 카드 안 안내만 보이고 입력은 그대로 된다
    if (site === state.site) paintWeather(`${keyword} 날씨`, '지금은 날씨를 불러오지 못했습니다. 눌러서 지역을 확인하세요.');
  }
}

// 지역 이름을 이 폰에서 직접 정한다. 비우면 현장 이름에서 다시 자동으로 찾는다
function pickPlace() {
  const site = state.site;
  if (!site) return;
  const input = prompt('날씨를 볼 지역 이름 (예: 당산동)\n비우면 현장 이름에서 자동으로 찾습니다. 이 폰에만 적용됩니다.', placeKeyword(site));
  if (input === null) return;
  const name = input.trim();
  if (name) store.set(`place:${site}`, name); else store.remove(`place:${site}`);
  refreshWeather();
}

const weatherRecord = () => state.weather?.record ?? '';

if (typeof module !== 'undefined') module.exports = { siteToPlace, weatherText, weatherLine, rain };
