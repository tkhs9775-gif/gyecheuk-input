// 명함 모서리 찾기 작업 스레드(card-live.js 가 부른다): 화면을 막지 않고 계산해서 사각형이 끊기지 않게 한다.
// 받는 것 { id, width, height, buf(RGBA) } → 돌려주는 것 { id, quad }  (quad: { tl, tr, br, bl } 0~1 비율 또는 null)
const V = new URL(self.location.href).searchParams.get('v') || '';
importScripts(`card-detect.js${V ? `?v=${V}` : ''}`);

let oc = null;
self.onmessage = (e) => {
  const { id, width, height, buf, bitmap } = e.data;
  let quad = null;
  try {
    let img;
    if (bitmap) {
      if (typeof OffscreenCanvas !== 'function') { bitmap.close?.(); self.postMessage({ id, unsupported: true }); return; }
      if (!oc || oc.width !== bitmap.width || oc.height !== bitmap.height) oc = new OffscreenCanvas(bitmap.width, bitmap.height);
      const g = oc.getContext('2d', { willReadFrequently: true });
      g.drawImage(bitmap, 0, 0);
      img = g.getImageData(0, 0, oc.width, oc.height);
      bitmap.close?.();
    } else img = { width, height, data: new Uint8ClampedArray(buf) };
    quad = self.CardDetect.detectQuad({ width: img.width, height: img.height, data: img.data });
  } catch { quad = null; }
  self.postMessage({ id, quad });
};
