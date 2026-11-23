// 명함 모서리 찾기 작업 스레드(card-live.js 가 부른다): 화면을 막지 않고 계산해서 사각형이 끊기지 않게 한다.
// 받는 것 { id, width, height, buf(RGBA) } → 돌려주는 것 { id, quad }  (quad: { tl, tr, br, bl } 0~1 비율 또는 null)
const V = new URL(self.location.href).searchParams.get('v') || '';
importScripts(`card-detect.js${V ? `?v=${V}` : ''}`);

self.onmessage = (e) => {
  const { id, width, height, buf } = e.data;
  let quad = null;
  try { quad = self.CardDetect.detectQuad({ width, height, data: new Uint8ClampedArray(buf) }); } catch { quad = null; }
  self.postMessage({ id, quad });
};
