// CAD 탭 작업자(모듈 워커): Pure Rust(cadpocket/acadrust wasm)로 DWG·DXF를 DXF 변환 없이 직접 파싱하고
// 도각·글자·블록·레이어·스냅 도구 모델을 생성한다. (미지원 구형 DWG만 libredwg 폴백)
import './rust-core.js';
import './cad-engine.js';

let pocketP = null;
let libP = null;
const say = (text) => self.postMessage({ progress: text });
const isWasmLoadErr = (err) => /wasm|webassembly|compile|magic word|fetch|Failed to fetch/i.test(String(err?.message ?? err));

async function ensurePocket() {
  if (!pocketP) {
    say('CADPocket DWG/DXF 엔진을 준비하는 중...');
    pocketP = (async () => {
      const m = await import('./vendor/cadpocket/cadpocket.js');
      await m.default({ module_or_path: new URL('./vendor/cadpocket/cadpocket_bg.wasm', import.meta.url) });
      return m;
    })().catch((e) => { pocketP = null; throw e; });
  }
  return pocketP;
}

async function ensureLibre() {
  if (!libP) {
    say('구형 DWG 보조 변환 도구를 준비하는 중...');
    libP = (async () => {
      const { LibreDwg, Dwg_File_Type } = await import('./vendor/libredwg/lib/index.js');
      const lib = await LibreDwg.create();
      return { lib, Dwg_File_Type };
    })().catch((e) => { libP = null; throw e; });
  }
  return libP;
}

function finalizeModel(model, dxf) {
  say('도각·블록 정보를 정리하는 중...');
  const E = self.CadEngine;
  const frames = E.cadFindFrames(model);
  const clusters = frames.length ? [] : E.cadClusterFrames(model);
  const out = {
    polys: model.polys,
    fills: model.fills,
    texts: model.texts,
    snaps: model.snaps,
    layers: model.layers,
    extents: model.extents,
    fullExtents: model.fullExtents,
    units: model.units,
    truncated: model.truncated,
    blocks: E.cadBlockTable(model),
    skipped: Array.isArray(model.skipped) ? model.skipped : [...model.skipped],
  };
  const xfer = dxf ? [model.snaps.buffer, dxf.buffer] : [model.snaps.buffer];
  self.postMessage({ ok: true, model: out, frames, clusters, dxf: dxf || null }, xfer);
}

async function runLibreFallback(data, isDxf) {
  const { lib, Dwg_File_Type } = await ensureLibre();
  let dxf = null;
  if (data.wantDxf) {
    say('CADPocket 보조용 DXF로 바꾸는 중...');
    dxf = isDxf ? new Uint8Array(data.buf.slice(0)) : lib.dwg_write_dxf(data.buf);
  }
  if (data.onlyDxf) {
    if (!dxf?.length) throw new Error('DWG를 DXF로 바꾸지 못했습니다. 파일이 손상됐거나 지원하지 않는 버전일 수 있습니다.');
    self.postMessage({ ok: true, dxf }, [dxf.buffer]);
    return;
  }
  say('보조 엔진으로 도면을 읽는 중...');
  const ptr = lib.dwg_read_data(data.buf, isDxf ? Dwg_File_Type.DXF : Dwg_File_Type.DWG);
  if (ptr == null) throw new Error('도면 파일을 읽지 못했습니다. 파일이 손상됐거나 지원하지 않는 버전일 수 있습니다.');
  let db;
  try { db = lib.convert(ptr); } finally { try { lib.dwg_free(ptr); } catch { /* 해제 실패는 무시 */ } }
  const model = self.CadEngine.cadBuild(db);
  finalizeModel(model, dxf);
}

self.onmessage = async ({ data }) => {
  try {
    const isDxf = /\.dxf$/i.test(data.name);
    if (data.onlyDxf) {
      await runLibreFallback(data, isDxf);
      return;
    }
    const rawBytes = new Uint8Array(data.buf);
    const cadFmt = typeof self.rustSniffCadFormat === 'function' ? self.rustSniffCadFormat(rawBytes) : 0;
    if (cadFmt === 2 && !isDxf) {
      await runLibreFallback({ ...data, wantDxf: true }, false);
      return;
    }
    const m = await ensurePocket();
    say('DWG/DXF 원본을 직접 읽는 중...');
    try {
      const model = m.extract_cad_tools(data.name, rawBytes);
      finalizeModel(model, null);
      return;
    } catch (rustErr) {
      if (isWasmLoadErr(rustErr)) throw rustErr;
      try {
        await runLibreFallback({ ...data, wantDxf: !isDxf }, isDxf);
      } catch {
        throw rustErr;
      }
    }
  } catch (err) {
    self.postMessage({ ok: false, error: String(err?.message || err) });
  }
};
