// 사진·스캔 글자 읽기(OCR) 공용 도구: 일정 계획서(schedule.js)가 쓴다(명함은 2026-11-11 오후부터 OCR 없이 사진 보정만). PC(pc-app/ui/ocr-kit.js)는 이 파일 복사본 — 바꾸면 둘 다.
// Tesseract.js 는 CDN 에서 처음 쓸 때 받는다(한글+영어 학습 자료 포함 약 15MB, 그 뒤로는 브라우저가 저장해 둔다)
const OCR_LIB = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
const OCR_WIDTH = 2200;   // 사진을 이 폭(px)으로 맞춰 읽는다(작으면 글자를 못 읽고, 크면 폰이 느리다)

let ocrLoading = null;
function ocrLoad() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!ocrLoading) {
    ocrLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = OCR_LIB;
      s.onload = () => (window.Tesseract ? resolve(window.Tesseract) : reject(new Error('글자 읽기 기능 파일이 올바르지 않습니다.')));
      s.onerror = () => { s.remove(); ocrLoading = null; reject(new Error(navigator.onLine === false ? '신호가 없어 글자 읽기 기능을 받지 못했습니다. 신호가 잡히면 다시 해 주세요.' : '글자 읽기 기능을 받지 못했습니다. 잠시 후 다시 해 주세요.')); };
      document.head.appendChild(s);
    });
  }
  return ocrLoading;
}

async function ocrImageCanvas(file, width = OCR_WIDTH) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(2, width / bmp.width);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#FFF';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}

// 그림 → OCR 단어(위치) + 칸 안 잉크 비율 함수 + 세로 칸선 + 줄 글자
async function ocrCanvas(canvas, label) {
  const Tesseract = await ocrLoad();
  const { data } = await Tesseract.recognize(canvas, 'kor+eng', {
    logger: (m) => { if (m.status === 'recognizing text') window.busyText?.(`${label} 글자 읽는 중 ${Math.round((m.progress || 0) * 100)}%`); },
  });
  const items = (data.words || []).map((w) => ({ str: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 }));
  const px = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  const W = canvas.width;
  const H = canvas.height;
  const inkAt = (b) => {
    const x0 = Math.max(0, Math.floor(b.x0));
    const x1 = Math.min(W, Math.ceil(b.x1));
    const y0 = Math.max(0, Math.floor(b.y0));
    const y1 = Math.min(H, Math.ceil(b.y1));
    let dark = 0;
    let all = 0;
    for (let y = y0; y < y1; y += 1) {
      for (let x = x0; x < x1; x += 1) {
        const i = (y * W + x) * 4;
        if (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11 < 140) dark += 1;
        all += 1;
      }
    }
    return all ? dark / all : 0;
  };
  const lines = (data.lines || []).filter((l) => l.text && l.text.trim()).map((l) => ({ text: l.text.trim(), x0: l.bbox.x0, y0: l.bbox.y0, x1: l.bbox.x1, y1: l.bbox.y1 }));
  return { items, inkAt, vlines: ocrVerticalLines(px, W, H), lines, text: data.text || '' };
}

// 표의 세로 칸선 찾기: x 마다(좌우 1px 포함) 위아래로 이어진 어두운 줄의 가장 긴 길이. 그림 높이의 20% 넘게 이어지면 칸선.
// 사진이 조금 기울어도 되게 짧은 끊김(4px)은 이어 본다. 붙어 있는 x 들은 가운데 하나로 합친다
function ocrVerticalLines(px, W, H) {
  // 밝기 기준이 아니라 대비 기준: 좌우 4px 옆보다 18 이상 어두우면 선 위의 점(옅은 회색 칸선·그늘진 사진도 잡힌다)
  const lum = (x, y) => { const i = (y * W + x) * 4; return px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11; };
  const dark = (x, y) => { const v = lum(x, y); return v < 235 && v < Math.min(lum(x - 4, y), lum(x + 4, y)) - 18; };
  const need = H * 0.2;
  const hits = [];
  for (let x = 5; x < W - 5; x += 1) {
    let run = 0;
    let gap = 0;
    let best = 0;
    for (let y = 0; y < H; y += 1) {
      if (dark(x - 1, y) || dark(x, y) || dark(x + 1, y)) { run += 1 + gap; gap = 0; if (run > best) best = run; } else if (run && gap < 4) gap += 1; else { run = 0; gap = 0; }
    }
    if (best >= need) hits.push(x);
  }
  const lines = [];
  let start = null;
  hits.forEach((x, i) => {
    if (start === null) start = x;
    if (hits[i + 1] !== x + 1) { lines.push((start + x) / 2); start = null; }
  });
  return lines;
}

