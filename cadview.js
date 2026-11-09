// PC 프로그램 CAD 탭 보기 창: ?src=<도면 주소>&name=<파일 이름>&v=<판>. 받기 → (DWG 면 DXF 로 바꾸기) → CADPocket 으로 그린다.
// 부모 창에는 { cadview: 'busy', text } / { cadview: 'ready' } / { cadview: 'error', message } / { cadview: 'close' } 를 보낸다.
const qs = new URLSearchParams(location.search);
const SRC = qs.get('src') || '';
const NAME = qs.get('name') || '도면.dwg';
const V = qs.get('v') || '0';
const tell = (msg) => parent.postMessage({ cadview: true, ...msg }, '*');
const busy = (text) => tell({ type: 'busy', text });

function fail(message) {
  const p = document.getElementById('err');
  p.textContent = message;
  p.style.display = 'grid';
  tell({ type: 'error', message });
}

// 새 DXF(2007+)는 UTF-8, 옛 한글 DXF 는 CP949(euc-kr)
function dxfText(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('euc-kr').decode(bytes); }
}

function toDxf(buf) {
  return new Promise((resolve, reject) => {
    const w = new Worker(`cad-worker.js?v=${V}`, { type: 'module' });
    w.onmessage = ({ data }) => {
      if (data.progress) { busy(data.progress); return; }
      w.terminate();
      if (data.ok) resolve(data.dxf); else reject(new Error(data.error));
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || '도면 읽기 도구가 멈췄습니다.')); };
    w.postMessage({ name: NAME, buf, wantDxf: true, onlyDxf: true }, [buf]);
  });
}

async function main() {
  if (!SRC) { fail('열 도면이 없습니다.'); return; }
  busy('도면 파일을 불러오는 중...');
  const res = await fetch(SRC);
  if (!res.ok) throw new Error(`도면 파일을 불러오지 못했습니다 (${res.status}).`);
  const buf = await res.arrayBuffer();
  const dxf = /\.dxf$/i.test(NAME) ? new Uint8Array(buf) : await toDxf(buf);
  busy('CADPocket 화면을 여는 중...');
  const m = await import(`./vendor/cadpocket/cadpocket.js?v=${V}`);
  await m.default();
  const h = new m.CadPocket();
  const say = (text) => tell({ type: 'note', text });
  await h.start(document.getElementById('cv'),
    () => say('다른 도면은 왼쪽 목록에서 고르세요.'),
    () => say('PDF 만들기(도각 추적)는 폰 앱 CAD 탭에서 할 수 있습니다.'),
    () => tell({ type: 'close' }));
  h.open(NAME, dxfText(dxf));
  document.getElementById('cv').focus();
  tell({ type: 'ready' });
}

main().catch((err) => fail(`도면을 열지 못했습니다.\n${err?.message || err}`));
