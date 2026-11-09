// CAD 탭 작업자(모듈 워커): DWG·DXF 읽기(libredwg wasm, 3~7초)와 그릴 목록 만들기를 화면 스레드 밖에서 한다(그동안 모래시계·화면이 멈추지 않게).
// 받는 것 { name, buf(ArrayBuffer) } → 보내는 것 { ok, model, frames } 또는 { ok:false, error }
import { LibreDwg, Dwg_File_Type } from './vendor/libredwg/lib/index.js';
import './cad-engine.js';

let libP = null;
const say = (text) => self.postMessage({ progress: text });

self.onmessage = async ({ data }) => {
  try {
    if (!libP) { say('도면 읽는 도구를 준비하는 중... (처음 한 번은 몇 초 걸립니다)'); libP = LibreDwg.create().catch((e) => { libP = null; throw e; }); }
    const lib = await libP;
    say('도면 파일을 읽는 중...');
    const isDxf = /\.dxf$/i.test(data.name);
    // CADPocket(cadcraft 엔진, wasm)은 DXF 를 읽으므로 DWG 는 DXF 글자로도 바꿔 둔다(libredwg 의 DXF 쓰기, 2초 안팎)
    let dxf = null;
    if (data.wantDxf) {
      say('CADPocket 엔진용으로 DXF 로 바꾸는 중...');
      dxf = isDxf ? new Uint8Array(data.buf.slice(0)) : lib.dwg_write_dxf(data.buf);
      say('도면 파일을 읽는 중...');
    }
    // PC 프로그램 보기 창(cadview.js)은 CADPocket 만 쓰므로 DXF 만 돌려준다(그릴 목록 만들기를 건너뛰어 큰 도면에서 수 초·메모리 절약)
    if (data.onlyDxf) {
      if (!dxf?.length) throw new Error('DWG 를 DXF 로 바꾸지 못했습니다. 파일이 손상됐거나 지원하지 않는 버전일 수 있습니다.');
      self.postMessage({ ok: true, dxf }, [dxf.buffer]);
      return;
    }
    const ptr = lib.dwg_read_data(data.buf, isDxf ? Dwg_File_Type.DXF : Dwg_File_Type.DWG);
    if (ptr == null) throw new Error('도면 파일을 읽지 못했습니다. 파일이 손상됐거나 지원하지 않는 버전일 수 있습니다.');
    let db;
    try { db = lib.convert(ptr); } finally { try { lib.dwg_free(ptr); } catch { /* 해제 실패는 무시 */ } }
    say('도면을 화면용으로 정리하는 중...');
    const E = self.CadEngine;
    const model = E.cadBuild(db);
    const frames = E.cadFindFrames(model);
    const out = {
      polys: model.polys, fills: model.fills, texts: model.texts, snaps: model.snaps, layers: model.layers,
      extents: model.extents, fullExtents: model.fullExtents, units: model.units, truncated: model.truncated,
      blocks: E.cadBlockTable(model), skipped: [...model.skipped],
    };
    const clusters = frames.length ? [] : E.cadClusterFrames(model);
    self.postMessage({ ok: true, model: out, frames, clusters, dxf }, dxf ? [model.snaps.buffer, dxf.buffer] : [model.snaps.buffer]);
  } catch (err) {
    self.postMessage({ ok: false, error: String(err?.message || err) });
  }
};
