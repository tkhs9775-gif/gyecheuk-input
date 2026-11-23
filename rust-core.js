// Rust WebAssembly 가속 코어(vendor/gyecheuk_core.wasm):
// Base64 고속 변환(LUT)·바이너리 썸네일 번들(GKT1) 패킹/언패킹·PDF/이미지 헤더 판별·고해상도 도면 타일 계산을 Rust 선형 메모리에서 수행한다.
(function initRustCore(root) {
  const MIME_BY_CODE = { 1: 'image/jpeg', 2: 'image/png', 3: 'image/webp', 4: 'application/pdf' };
  const textEnc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  const textDec = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;

  let wasm = null;
  let loadPromise = null;

  function tryInstantiateSync(bytes) {
    try {
      const mod = new WebAssembly.Module(bytes);
      const inst = new WebAssembly.Instance(mod, {});
      wasm = inst.exports;
      return wasm;
    } catch {
      return null;
    }
  }

  function ensureRustWasm(customUrl) {
    if (wasm) return Promise.resolve(wasm);
    if (customUrl instanceof Uint8Array || customUrl instanceof ArrayBuffer) {
      return Promise.resolve(tryInstantiateSync(customUrl));
    }
    if (loadPromise) return loadPromise;
    const buildVer = (typeof document !== 'undefined' && document.currentScript && new URL(document.currentScript.src, document.baseURI).searchParams.get('v')) || '';
    const rel = `vendor/gyecheuk_core.wasm${buildVer ? `?v=${buildVer}` : ''}`;
    const base = (typeof document !== 'undefined' && document.baseURI) || (typeof self !== 'undefined' && self.location && self.location.href) || 'http://localhost/';
    const url = customUrl || new URL(rel, base).href;
    if (typeof fetch !== 'function') return Promise.resolve(null);
    loadPromise = fetch(url)
      .then((res) => {
        if (!res || !res.ok) throw new Error(`wasm status ${res ? res.status : 0}`);
        if (typeof WebAssembly.instantiateStreaming === 'function' && (res.headers?.get('content-type') || '').includes('wasm')) {
          return WebAssembly.instantiateStreaming(res, {});
        }
        return res.arrayBuffer().then((buf) => WebAssembly.instantiate(buf, {}));
      })
      .then((res) => {
        wasm = (res.instance || res).exports;
        return wasm;
      })
      .catch(() => {
        loadPromise = null;
        return null;
      });
    return loadPromise;
  }

  function rustB64ToBytes(b64) {
    if (typeof b64 !== 'string' || !b64.length) return new Uint8Array(0);
    const comma = b64.indexOf(',');
    const clean = comma >= 0 && comma < 64 && b64.slice(0, comma).includes('base64') ? b64.slice(comma + 1) : b64;
    if (wasm && textEnc) {
      const capLen = clean.length;
      const dstCap = wasm.wasm_b64_decoded_cap(capLen);
      const srcPtr = wasm.wasm_alloc(capLen);
      const dstPtr = wasm.wasm_alloc(dstCap);
      if (srcPtr && dstPtr) {
        try {
          let srcLen = capLen;
          if (typeof textEnc.encodeInto === 'function') {
            srcLen = textEnc.encodeInto(clean, new Uint8Array(wasm.memory.buffer, srcPtr, capLen)).written;
          } else {
            const sb = textEnc.encode(clean);
            srcLen = sb.byteLength;
            new Uint8Array(wasm.memory.buffer, srcPtr, srcLen).set(sb);
          }
          const written = wasm.wasm_b64_decode(srcPtr, srcLen, dstPtr, dstCap);
          if (written !== 0xFFFFFFFF && written <= dstCap) {
            return new Uint8Array(wasm.memory.buffer.slice(dstPtr, dstPtr + written));
          }
        } finally {
          wasm.wasm_dealloc(srcPtr, capLen);
          wasm.wasm_dealloc(dstPtr, dstCap);
        }
      }
    }
    const norm = clean.replace(/[\s\r\n]+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(norm, 'base64'));
    const bin = atob(norm);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  function rustBytesToB64(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (!u8.byteLength) return '';
    if (wasm && textDec) {
      const srcLen = u8.byteLength;
      const dstCap = wasm.wasm_b64_encoded_len(srcLen);
      const srcPtr = wasm.wasm_alloc(srcLen);
      const dstPtr = wasm.wasm_alloc(dstCap);
      if (srcPtr && dstPtr) {
        try {
          new Uint8Array(wasm.memory.buffer, srcPtr, srcLen).set(u8);
          const written = wasm.wasm_b64_encode(srcPtr, srcLen, dstPtr, dstCap);
          if (written !== 0xFFFFFFFF && written <= dstCap) {
            return textDec.decode(new Uint8Array(wasm.memory.buffer, dstPtr, written));
          }
        } finally {
          wasm.wasm_dealloc(srcPtr, srcLen);
          wasm.wasm_dealloc(dstPtr, dstCap);
        }
      }
    }
    if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
    let bin = '';
    const step = 0x8000;
    for (let i = 0; i < u8.length; i += step) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + step));
    }
    return btoa(bin);
  }

  function rustSniffMimeCode(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (u8.byteLength < 4) return 0;
    if (wasm) {
      const len = Math.min(u8.byteLength, 1024);
      const ptr = wasm.wasm_alloc(len);
      if (ptr) {
        try {
          new Uint8Array(wasm.memory.buffer, ptr, len).set(u8.subarray(0, len));
          return wasm.wasm_sniff_mime(ptr, len) >>> 0;
        } finally {
          wasm.wasm_dealloc(ptr, len);
        }
      }
    }
    if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) return 2;
    if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46) return 3;
    if (u8[0] === 0xFF && u8[1] === 0xD8) return 1;
    return 0;
  }

  function rustSniffImageMime(bytes) {
    const code = rustSniffMimeCode(bytes);
    return MIME_BY_CODE[code] && code !== 4 ? MIME_BY_CODE[code] : 'image/jpeg';
  }

  function rustLooksLikePdf(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (u8.byteLength < 4) return false;
    const len = Math.min(u8.byteLength, 1024);
    if (wasm) {
      const ptr = wasm.wasm_alloc(len);
      if (ptr) {
        try {
          new Uint8Array(wasm.memory.buffer, ptr, len).set(u8.subarray(0, len));
          return wasm.wasm_looks_like_pdf(ptr, len) === 1;
        } finally {
          wasm.wasm_dealloc(ptr, len);
        }
      }
    }
    for (let i = 0; i <= len - 4; i += 1) {
      if (u8[i] === 0x25 && u8[i + 1] === 0x50 && u8[i + 2] === 0x44 && u8[i + 3] === 0x46) return true;
    }
    return false;
  }

  function rustPlanTiles(cssWOrOpts, cssH, dpr = 1, tilePx = 512, vx0 = 0, vy0 = 0, vx1 = 0, vy1 = 0, pad = 128, maxTiles = 64) {
    let cw = cssWOrOpts;
    let ch = cssH;
    let scale = dpr;
    let tPx = tilePx;
    let left = vx0;
    let top = vy0;
    let right = vx1;
    let bottom = vy1;
    let margin = pad;
    let cap = maxTiles;
    if ( cssWOrOpts && typeof cssWOrOpts === 'object') {
      cw = Number(cssWOrOpts.pageW) || 0;
      ch = Number(cssWOrOpts.pageH) || 0;
      scale = 1;
      tPx = Number(cssWOrOpts.tileSize ?? 512);
      left = Number(cssWOrOpts.viewLeft) || 0;
      top = Number(cssWOrOpts.viewTop) || 0;
      const vw = Number(cssWOrOpts.viewW) || 0;
      const vh = Number(cssWOrOpts.viewH) || 0;
      if (!(cw > 0 && ch > 0 && vw > 0 && vh > 0 && tPx > 0)) return [];
      right = left + vw;
      bottom = top + vh;
      margin = Number(cssWOrOpts.margin ?? 128);
      cap = Number(cssWOrOpts.maxTiles ?? 64);
    }
    if (!(cw > 0 && ch > 0 && scale > 0 && tPx > 0 && right > left && bottom > top)) return [];
    if (wasm && cap > 0) {
      const byteLen = cap * 6 * 4;
      const outPtr = wasm.wasm_alloc(byteLen);
      if (outPtr) {
        try {
          const count = wasm.wasm_plan_tiles(cw, ch, scale, tPx, left, top, right, bottom, margin, outPtr, cap);
          const view = new Int32Array(wasm.memory.buffer, outPtr, count * 6);
          const tiles = new Array(count);
          for (let i = 0; i < count; i += 1) {
            const b = i * 6;
            const c = view[b], r = view[b + 1];
            tiles[i] = { col: c, row: r, x: view[b + 2], y: view[b + 3], w: view[b + 4], h: view[b + 5], key: `${c},${r}` };
          }
          return tiles;
        } finally {
          wasm.wasm_dealloc(outPtr, byteLen);
        }
      }
    }
    const fullW = Math.max(1, Math.round(cw * scale));
    const fullH = Math.max(1, Math.round(ch * scale));
    const x0 = Math.max(0, Math.min(fullW, Math.floor((left - margin) * scale)));
    const y0 = Math.max(0, Math.min(fullH, Math.floor((top - margin) * scale)));
    const x1 = Math.max(0, Math.min(fullW, Math.ceil((right + margin) * scale)));
    const y1 = Math.max(0, Math.min(fullH, Math.ceil((bottom + margin) * scale)));
    if (x1 <= x0 || y1 <= y0) return [];
    const c0 = Math.floor(x0 / tPx), r0 = Math.floor(y0 / tPx);
    const c1 = Math.floor((x1 - 1) / tPx), r1 = Math.floor((y1 - 1) / tPx);
    const cx = (left + right) * 0.5 * scale, cy = (top + bottom) * 0.5 * scale;
    const list = [];
    for (let r = r0; r <= r1; r += 1) {
      for (let c = c0; c <= c1; c += 1) {
        const x = c * tPx, y = r * tPx;
        const w = Math.min(tPx, fullW - x), h = Math.min(tPx, fullH - y);
        if (w <= 0 || h <= 0) continue;
        const dx = (x + w * 0.5) - cx, dy = (y + h * 0.5) - cy;
        list.push({ col: c, row: r, x, y, w, h, key: `${c},${r}`, d2: dx * dx + dy * dy });
      }
    }
    list.sort((a, b) => a.d2 - b.d2);
    return list.slice(0, cap).map(({ d2, ...t }) => t);
  }

  // GKT1 바이너리 썸네일 번들: [GKT1(4)][count:u16LE] + count * ([idLen:u16LE][mime:u8][0:u8][dataLen:u32LE][idBytes][dataBytes])
  function packThumbBundle(entries) {
    const items = [];
    let total = 6;
    for (const [id, raw] of Object.entries(entries || {})) {
      if (!id || !raw) continue;
      const data = raw instanceof Uint8Array ? raw : rustB64ToBytes(String(raw));
      if (!data.byteLength) continue;
      const idBytes = textEnc ? textEnc.encode(id) : new Uint8Array([...id].map((c) => c.charCodeAt(0) & 0xFF));
      if (!idBytes.byteLength || idBytes.byteLength > 0xFFFF) continue;
      const mimeCode = rustSniffMimeCode(data) || 1;
      items.push({ idBytes, mimeCode, data });
      total += 8 + idBytes.byteLength + data.byteLength;
    }
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    out[0] = 0x47; out[1] = 0x4B; out[2] = 0x54; out[3] = 0x31; // "GKT1"
    dv.setUint16(4, items.length, true);
    let pos = 6;
    for (const it of items) {
      dv.setUint16(pos, it.idBytes.byteLength, true);
      out[pos + 2] = it.mimeCode;
      out[pos + 3] = 0;
      dv.setUint32(pos + 4, it.data.byteLength, true);
      pos += 8;
      out.set(it.idBytes, pos);
      pos += it.idBytes.byteLength;
      out.set(it.data, pos);
      pos += it.data.byteLength;
    }
    return out;
  }

  function unpackThumbBundle(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf || []);
    if (u8.byteLength < 6 || u8[0] !== 0x47 || u8[1] !== 0x4B || u8[2] !== 0x54 || u8[3] !== 0x31) return null;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const count = dv.getUint16(4, true);
    let pos = 6;
    const out = {};
    for (let i = 0; i < count; i += 1) {
      if (pos + 8 > u8.byteLength) break;
      const idLen = dv.getUint16(pos, true);
      const mimeCode = u8[pos + 2];
      const dataLen = dv.getUint32(pos + 4, true);
      pos += 8;
      if (pos + idLen + dataLen > u8.byteLength) break;
      const idSlice = u8.subarray(pos, pos + idLen);
      const id = textDec ? textDec.decode(idSlice) : String.fromCharCode.apply(null, idSlice);
      pos += idLen;
      const bytes = u8.subarray(pos, pos + dataLen);
      pos += dataLen;
      out[id] = { bytes, mime: MIME_BY_CODE[mimeCode] || 'image/jpeg' };
    }
    return out;
  }

  // CAD 파일 헤더 판별: 1 = 최신 DWG(AC1015..AC1032, cadpocket 직접 지원), 2 = 구형 DWG(AC1012/AC1014 등, libredwg 폴백), 3 = DXF, 0 = 미상
  function rustSniffCadFormat(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (u8.byteLength < 6) return 0;
    const len = Math.min(u8.byteLength, 256);
    if (wasm && typeof wasm.wasm_sniff_cad_format === 'function') {
      const ptr = wasm.wasm_alloc(len);
      if (ptr) {
        try {
          new Uint8Array(wasm.memory.buffer, ptr, len).set(u8.subarray(0, len));
          return wasm.wasm_sniff_cad_format(ptr, len) >>> 0;
        } finally {
          wasm.wasm_dealloc(ptr, len);
        }
      }
    }
    if (u8[0] === 0x41 && u8[1] === 0x43) { // "AC"
      const ver = String.fromCharCode(u8[0], u8[1], u8[2], u8[3], u8[4], u8[5]);
      if (/^AC10(15|18|21|24|27|32)$/.test(ver)) return 1;
      if (/^AC(1014|1012|1009|1006|1004|1003|1002|1\.50|2\.10)$/.test(ver)) return 2;
      return 1;
    }
    const head = textDec ? textDec.decode(u8.subarray(0, len)) : String.fromCharCode.apply(null, u8.subarray(0, len));
    if (head.startsWith('AutoCAD Binary DXF') || /^\s*(?:0|999)\s[\s\S]*?(?:SECTION|ENTITIES)/i.test(head)) return 3;
    return 0;
  }

  // 대용량 DWG·DXF 병렬 다운로드 조각 계획: [{ offset, length, index }, ...]
  function rustPlanCadChunks(totalSize, chunkSize = 4 * 1024 * 1024, startOffset = 0) {
    const total = Math.max(0, Math.floor(Number(totalSize) || 0));
    const chunk = Math.max(1, Math.floor(Number(chunkSize) || (4 * 1024 * 1024)));
    const start = Math.max(0, Math.floor(Number(startOffset) || 0));
    if (start >= total) return [];
    const maxChunks = Math.ceil((total - start) / chunk) + 1;
    if (wasm && typeof wasm.wasm_plan_cad_chunks === 'function') {
      const byteLen = maxChunks * 3 * 4;
      const outPtr = wasm.wasm_alloc(byteLen);
      if (outPtr) {
        try {
          const count = wasm.wasm_plan_cad_chunks(total, chunk, start, outPtr, maxChunks);
          const view = new Uint32Array(wasm.memory.buffer, outPtr, count * 3);
          const plan = new Array(count);
          for (let i = 0; i < count; i += 1) {
            const b = i * 3;
            plan[i] = { offset: view[b], length: view[b + 1], index: view[b + 2] };
          }
          return plan;
        } finally {
          wasm.wasm_dealloc(outPtr, byteLen);
        }
      }
    }
    const plan = [];
    for (let at = start, idx = Math.floor(start / chunk); at < total; at += chunk, idx += 1) {
      plan.push({ offset: at, length: Math.min(chunk, total - at), index: idx });
    }
    return plan;
  }

  // Base64 조각을 목표 버퍼(targetU8)의 지정된 offset 위치에 직접 고속 디코딩한다.
  function rustDecodeB64At(b64, targetU8, offset = 0) {
    if (typeof b64 !== 'string' || !b64.length || !(targetU8 instanceof Uint8Array)) return 0;
    const at = Math.max(0, Math.floor(Number(offset) || 0));
    if (at >= targetU8.byteLength) return 0;
    if (wasm && textEnc && typeof wasm.wasm_b64_decode_at === 'function') {
      const capLen = b64.length;
      const dstCap = Math.min(targetU8.byteLength - at, wasm.wasm_b64_decoded_cap(capLen));
      const srcPtr = wasm.wasm_alloc(capLen);
      const dstPtr = wasm.wasm_alloc(dstCap);
      if (srcPtr && dstPtr) {
        try {
          let srcLen = capLen;
          if (typeof textEnc.encodeInto === 'function') {
            srcLen = textEnc.encodeInto(b64, new Uint8Array(wasm.memory.buffer, srcPtr, capLen)).written;
          } else {
            const sb = textEnc.encode(b64);
            srcLen = sb.byteLength;
            new Uint8Array(wasm.memory.buffer, srcPtr, srcLen).set(sb);
          }
          const written = wasm.wasm_b64_decode_at(srcPtr, srcLen, dstPtr, dstCap, 0);
          if (written !== 0xFFFFFFFF && written <= dstCap) {
            targetU8.set(new Uint8Array(wasm.memory.buffer, dstPtr, written), at);
            return written;
          }
        } finally {
          wasm.wasm_dealloc(srcPtr, capLen);
          wasm.wasm_dealloc(dstPtr, dstCap);
        }
      }
    }
    const decoded = rustB64ToBytes(b64);
    if (at + decoded.byteLength > targetU8.byteLength) return 0;
    targetU8.set(decoded, at);
    return decoded.byteLength;
  }

  // DWG/DXF 바이너리 지문(64비트 FNV-1a 해시, 16자리 16진수 문자열)
  function rustFnv1a64(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (!u8.byteLength) return '0000000000000000';
    if (wasm && typeof wasm.wasm_fnv1a64 === 'function') {
      const len = u8.byteLength;
      const ptr = wasm.wasm_alloc(len);
      if (ptr) {
        try {
          new Uint8Array(wasm.memory.buffer, ptr, len).set(u8);
          const h = wasm.wasm_fnv1a64(ptr, len);
          const u64 = BigInt.asUintN(64, BigInt(h));
          return u64.toString(16).padStart(16, '0');
        } finally {
          wasm.wasm_dealloc(ptr, len);
        }
      }
    }
    let h = 0xcbf29ce484222325n;
    const prime = 0x100000001b3n;
    for (let i = 0; i < u8.byteLength; i += 1) {
      h ^= BigInt(u8[i]);
      h = BigInt.asUintN(64, h * prime);
    }
    return h.toString(16).padStart(16, '0');
  }

  // 수십만 개 CAD 폴리라인의 색상별 그룹 묶기(cadColorOrder)를 Rust 선형 메모리에서 수행한다.
  function rustCadColorOrder(polys) {
    if (!Array.isArray(polys) || !polys.length) return [];
    const n = polys.length;
    if (wasm && typeof wasm.wasm_cad_color_order === 'function') {
      const maxGroups = Math.min(n, 4096);
      const colorsBytes = n * 4;
      const groupsBytes = maxGroups * 4;
      const colorsPtr = wasm.wasm_alloc(colorsBytes);
      const outColorsPtr = wasm.wasm_alloc(groupsBytes);
      const outCountsPtr = wasm.wasm_alloc(groupsBytes);
      const outIndicesPtr = wasm.wasm_alloc(colorsBytes);
      if (colorsPtr && outColorsPtr && outCountsPtr && outIndicesPtr) {
        try {
          const inColors = new Uint32Array(wasm.memory.buffer, colorsPtr, n);
          for (let i = 0; i < n; i += 1) inColors[i] = (polys[i].c >>> 0);
          const gCount = wasm.wasm_cad_color_order(colorsPtr, n, outColorsPtr, outCountsPtr, outIndicesPtr, maxGroups);
          if (gCount > 0 && gCount <= maxGroups) {
            const outC = new Uint32Array(wasm.memory.buffer, outColorsPtr, gCount);
            const outCnt = new Uint32Array(wasm.memory.buffer, outCountsPtr, gCount);
            const idxBuf = wasm.memory.buffer.slice(outIndicesPtr, outIndicesPtr + colorsBytes);
            const res = new Array(gCount);
            let pos = 0;
            for (let g = 0; g < gCount; g += 1) {
              const cnt = outCnt[g];
              res[g] = { c: outC[g], idx: new Uint32Array(idxBuf, pos * 4, cnt) };
              pos += cnt;
            }
            return res;
          }
        } finally {
          wasm.wasm_dealloc(colorsPtr, colorsBytes);
          wasm.wasm_dealloc(outColorsPtr, groupsBytes);
          wasm.wasm_dealloc(outCountsPtr, groupsBytes);
          wasm.wasm_dealloc(outIndicesPtr, colorsBytes);
        }
      }
    }
    const by = new Map();
    for (let i = 0; i < n; i += 1) {
      const c = polys[i].c >>> 0;
      let arr = by.get(c);
      if (!arr) { arr = []; by.set(c, arr); }
      arr.push(i);
    }
    return [...by].map(([c, idx]) => ({ c, idx: Uint32Array.from(idx) }));
  }

  // 도면 저장 알림을 보낼지(Rust 판단). wasm 이 아직 없으면 null → 부르는 쪽이 같은 규칙으로 판단
  function rustDrawingNoticeDue(isLive, nowMs, lastMs) {
    if (!wasm || typeof wasm.wasm_drawing_notice_due !== 'function') return null;
    return wasm.wasm_drawing_notice_due(isLive ? 1 : 0, nowMs, lastMs || 0) === 1;
  }

  // 도면 동그라미 규칙(Rust 판단): 값 칸 수, 값을 도면에 늘 펼칠지. wasm 이 없으면 같은 규칙으로 판단
  const typeCode = (type) => String(type || '').charCodeAt(0) || 0;
  function rustPinValueCells(type) {
    if (wasm && typeof wasm.wasm_pin_value_cells === 'function') return wasm.wasm_pin_value_cells(typeCode(type));
    return type === 'L' ? 3 : 1;
  }
  function rustPinValuesOnDrawing(type) {
    if (wasm && typeof wasm.wasm_pin_values_on_drawing === 'function') return wasm.wasm_pin_values_on_drawing(typeCode(type)) === 1;
    return type !== 'L';
  }

  // 2026-11-18: 다시 볼 때·임시저장·기기 id 판단(Rust resume.rs·lock.rs). wasm 이 아직 없으면 같은 규칙의 JS 로 판단
  // 글자열 묶음 = 글자열마다 [길이 아래 16비트][길이 위 16비트][UTF-16 글자들] (apps-script/Code.gs rustLock 과 같은 모양)
  const hasFn = (name) => !!wasm && typeof wasm[name] === 'function';
  const str = (v) => (v == null ? '' : String(v));
  function callTexts(strs, fn) {
    const units = strs.reduce((n, s) => n + 2 + s.length, 0);
    const ptr = wasm.wasm_alloc(units * 2);
    try {
      const dv = new DataView(wasm.memory.buffer);   // 할당 뒤에 본다(메모리가 늘면 buffer 가 바뀐다)
      let o = ptr;
      for (const s of strs) {
        dv.setUint16(o, s.length & 0xFFFF, true); dv.setUint16(o + 2, s.length >>> 16, true); o += 4;
        for (let i = 0; i < s.length; i += 1, o += 2) dv.setUint16(o, s.charCodeAt(i), true);
      }
      return fn(ptr, units);
    } finally {
      wasm.wasm_dealloc(ptr, units * 2);
    }
  }
  // wasm 이 없거나 던지면(메모리 모자람 등) 같은 규칙의 JS 답: 다시 열기·임시저장이 멈추지 않게
  function viaWasm(name, run, js) {
    if (!hasFn(name)) return js();
    try { return run(); } catch (err) { console.warn(`${name} 실패, 같은 규칙의 JS 로 판단`, err); return js(); }
  }
  const RESUME_REFRESH_MS = 5 * 60 * 1000;   // resume.rs RESUME_REFRESH_MS
  // 앱이 다시 보일 때 할 일. today = 지금 오늘, autoDate = 앱이 측정일 칸에 넣은 오늘, fieldDate = 측정일 칸 값
  function rustResumePlan(today, autoDate, fieldDate, nowMs, lastBootMs) {
    const t = [str(today), str(autoDate), str(fieldDate)];
    const plan = viaWasm('wasm_resume_plan', () => callTexts(t, (p, n) => wasm.wasm_resume_plan(p, n, Number(nowMs), Number(lastBootMs))), () => {
      const newDay = t[0] !== t[1];
      const stale = Number(nowMs) - Number(lastBootMs) >= RESUME_REFRESH_MS;   // NaN 이면 false
      return (newDay ? 1 | (t[2] === t[1] ? 2 : 0) : 0) | (newDay || stale ? 4 : 0) | (stale ? 8 : 0);
    });
    return { rollDay: !!(plan & 1), setField: !!(plan & 2), sched: !!(plan & 4), fetchBoot: !!(plan & 8) };
  }
  // 일정 달력을 오늘로 옮길지: 처음 열 때, 또는 자정이 지났는데 그 전날을 보고 있었을 때만
  function rustSchedFollowToday(today, todayWas, selected) {
    const t = [str(today), str(todayWas), str(selected)];
    return viaWasm('wasm_sched_follow_today', () => callTexts(t, (p, n) => wasm.wasm_sched_follow_today(p, n)) === 1,
      () => !t[1] || (t[0] !== t[1] && t[2] === t[1]));
  }
  // 임시저장할 때: 측정일이 앱이 넣은 오늘 그대로인지
  function rustDateIsAuto(fieldDate, autoDate) {
    const t = [str(fieldDate), str(autoDate)];
    return viaWasm('wasm_date_is_auto', () => callTexts(t, (p, n) => wasm.wasm_date_is_auto(p, n)) === 1, () => t[0] === t[1]);
  }
  // 임시저장본을 되살릴 때 저장된 날짜를 쓸지: 사람이 고른 날짜만
  function rustDraftKeepsDate(hasDate, wasAuto) {
    return viaWasm('wasm_draft_keeps_date', () => wasm.wasm_draft_keeps_date(hasDate ? 1 : 0, wasAuto ? 1 : 0) === 1, () => !!hasDate && !wasAuto);
  }
  // 기기 id 모양(서버 lock.rs device_ok 와 같은 규칙: 8~64자, 영문·숫자·'-')
  function rustDeviceIdOk(id) {
    if (typeof id !== 'string') return false;
    return viaWasm('wasm_lock_device_ok', () => callTexts([id], (p, n) => wasm.wasm_lock_device_ok(p, n)) === 1, () => /^[A-Za-z0-9-]{8,64}$/.test(id));
  }

  // 2026-11-20: 현장 종료 확인 — 따라 쓴 글자가 현장 이름과 같은지(Rust sites.rs confirm_ok, 서버도 같은 함수로 다시 본다).
  // JS 대체 없음: wasm 이 없으면 null → 화면은 종료 버튼을 켜지 않는다
  function rustSiteConfirm(site, typed) {
    if (!hasFn('wasm_site_confirm')) return null;
    try {
      return callTexts([String(site ?? ''), String(typed ?? '')], (p, n) => wasm.wasm_site_confirm(p, n)) === 1;
    } catch (err) {
      console.warn('wasm_site_confirm 실패', err);
      return null;
    }
  }

  // 2026-11-19: 값 오타 제안·특이사항 메모 묶기(Rust ai.rs text_call). JS 대체 없음 — wasm 이 없으면 null → 화면은 제안·AI 버튼을 안 띄운다
  function textCall(op, strs) {
    if (!hasFn('wasm_text_call')) return null;
    const cap = strs.reduce((n, s) => n + 2 + s.length, 0) * 2 + 4096;
    const out = wasm.wasm_alloc(cap * 2);
    if (!out) return null;
    try {
      const n = callTexts(strs, (p, units) => wasm.wasm_text_call(op, p, units, out, cap));
      if (n < 0) return null;
      // out 은 홀수 주소일 수 있다 → 복사본으로 읽는다
      const dv = new DataView(wasm.memory.buffer.slice(out, out + n * 2));
      const res = [];
      for (let o = 0; o < n * 2;) {
        const len = dv.getUint16(o, true) | (dv.getUint16(o + 2, true) << 16);
        o += 4;
        let s = '';
        for (let i = 0; i < len; i += 1, o += 2) s += String.fromCharCode(dv.getUint16(o, true));
        res.push(s);
      }
      return res;
    } catch (err) {
      console.warn(`wasm_text_call ${op} 실패`, err);
      return null;
    } finally {
      wasm.wasm_dealloc(out, cap * 2);
    }
  }
  // 값 칸 오타 제안: null(고칠 것 없음·wasm 없음) 또는 { why, fixes }
  // 실시간 줄을 몇 ms 뒤에 보낼지(Rust livepins.rs send_wait_ms). wasm 이 없으면 null(부르는 쪽이 예전 방식)
  function rustLiveSendWaitMs(nowMs, lastChangeMs, firstPendingMs, leaving) {
    if (!wasm || typeof wasm.wasm_live_send_wait_ms !== 'function') return null;
    return wasm.wasm_live_send_wait_ms(nowMs, lastChangeMs, firstPendingMs, leaving ? 1 : 0);
  }

  function rustValueFix(text, prev) {
    const r = textCall(1, [str(text), str(prev)]);
    return r && r.length ? { why: r[0], fixes: r.slice(1) } : null;
  }
  // 2026-11-19 작업 1: 도면 메모 저장 전 동그라미 합치기(Rust merge.rs wasm_merge_notes). 합친 동그라미 배열, wasm 이 없거나 실패하면 null
  function rustMergeNotesPins(minePins, theirPins, today) {
    if (!hasFn('wasm_merge_notes')) return null;
    const strs = [JSON.stringify(Array.isArray(minePins) ? minePins : []), JSON.stringify(Array.isArray(theirPins) ? theirPins : []), str(today)];
    let cap = (strs[0].length + strs[1].length) * 2 + 4096;
    for (let tries = 0; tries < 3; tries += 1, cap *= 2) {   // -2 = 칸이 모자람 → 두 배로 다시
      const out = wasm.wasm_alloc(cap * 2);
      if (!out) return null;
      try {
        const n = callTexts(strs, (p, units) => wasm.wasm_merge_notes(p, units, out, cap));
        if (n === -2) continue;
        if (n < 0) return null;
        const u16 = new Uint16Array(wasm.memory.buffer.slice(out, out + n * 2));   // out 은 홀수 주소일 수 있다 → 복사본으로 읽는다
        let s = '';
        for (let i = 0; i < u16.length; i += 8192) s += String.fromCharCode.apply(null, u16.subarray(i, i + 8192));
        const pins = JSON.parse(s);
        return Array.isArray(pins) ? pins : null;
      } catch (err) {
        console.warn('wasm_merge_notes 실패', err);
        return null;
      } finally {
        wasm.wasm_dealloc(out, cap * 2);
      }
    }
    return null;
  }

  // 2026-11-19: 긴 메모를 칸 한도에 맞출 때 뺄 지난 기록(Rust trim.rs). [[동그라미 번호, history 번호], ...] 또는 null(wasm 없음·메모 모양 아님)
  function rustTrimPlan(notesJson, maxLen) {
    if (!hasFn('wasm_trim_plan')) return null;
    const cap = notesJson.length;   // 기록 하나는 JSON 으로 2글자 이상이라 쌍 수는 글자 수보다 적다
    const out = wasm.wasm_alloc(cap * 8);
    if (!out) return null;
    try {
      const n = callTexts([notesJson], (p, units) => wasm.wasm_trim_plan(p, units, maxLen >>> 0, out, cap));
      if (n < 0) return null;
      const dv = new DataView(wasm.memory.buffer.slice(out, out + n * 8));
      return Array.from({ length: n }, (_, i) => [dv.getUint32(i * 8, true), dv.getUint32(i * 8 + 4, true)]);
    } catch (err) {
      console.warn('wasm_trim_plan 실패', err);
      return null;
    } finally {
      wasm.wasm_dealloc(out, cap * 8);
    }
  }

  // 2026-11-23: 앱을 켤 때 물어볼 현장(Rust gpssite.rs pick). here = 지금 위치 주소 칸들, sites = [{ name, lat, lng }](좌표 모르면 null).
  // { mode: 0 묻지 않음 | 1 한 곳 확인 | 2 같은 동 목록, idx: 현장 번호(가까운 순) }. JS 대체 없음: wasm 이 없으면 null → 묻지 않는다
  function rustGpsPick(lat, lng, here, sites) {
    if (!hasFn('wasm_gps_pick')) return null;
    const h = (Array.isArray(here) ? here : []).map(str);
    const strs = [...h];
    for (const s of Array.isArray(sites) ? sites : []) strs.push(str(s?.name), s?.lat == null ? '' : String(s.lat), s?.lng == null ? '' : String(s.lng));
    const cap = (strs.length - h.length) / 3 + 1;
    const out = wasm.wasm_alloc(cap * 4);
    if (!out) return null;
    try {
      const n = callTexts(strs, (p, units) => wasm.wasm_gps_pick(p, units, h.length, Number(lat), Number(lng), out, cap));
      if (n < 1) return null;
      const dv = new DataView(wasm.memory.buffer.slice(out, out + n * 4));
      return { mode: dv.getUint32(0, true), idx: Array.from({ length: n - 1 }, (_, i) => dv.getUint32((i + 1) * 4, true)) };
    } catch (err) {
      console.warn('wasm_gps_pick 실패', err);
      return null;
    } finally {
      wasm.wasm_dealloc(out, cap * 4);
    }
  }

  const api = {
    gpsPick: rustGpsPick,
    mergeNotesPins: rustMergeNotesPins,
    trimPlan: rustTrimPlan,
    resumePlan: rustResumePlan,
    schedFollowToday: rustSchedFollowToday,
    dateIsAuto: rustDateIsAuto,
    draftKeepsDate: rustDraftKeepsDate,
    deviceIdOk: rustDeviceIdOk,
    siteConfirm: rustSiteConfirm,
    valueFix: rustValueFix,
    drawingNoticeDue: rustDrawingNoticeDue,
    pinValueCells: rustPinValueCells,
    pinValuesOnDrawing: rustPinValuesOnDrawing,
    liveSendWaitMs: rustLiveSendWaitMs,
    ensure: ensureRustWasm,
    ensureRustWasm,
    tryInstantiateSync,
    isWasmReady: () => !!wasm,
    b64ToBytes: rustB64ToBytes,
    bytesToB64: rustBytesToB64,
    sniffMimeCode: rustSniffMimeCode,
    sniffImageMime: rustSniffImageMime,
    looksLikePdf: rustLooksLikePdf,
    planTiles: rustPlanTiles,
    packThumbBundle,
    unpackThumbBundle,
    sniffCadFormat: rustSniffCadFormat,
    planCadChunks: rustPlanCadChunks,
    decodeB64At: rustDecodeB64At,
    fnv1a64: rustFnv1a64,
    cadColorOrder: rustCadColorOrder,
  };

  root.RustCore = api;
  root.rustB64ToBytes = rustB64ToBytes;
  root.rustBytesToB64 = rustBytesToB64;
  root.rustSniffImageMime = rustSniffImageMime;
  root.rustLooksLikePdf = rustLooksLikePdf;
  root.rustPlanTiles = rustPlanTiles;
  root.rustPackThumbBundle = packThumbBundle;
  root.rustUnpackThumbBundle = unpackThumbBundle;
  root.rustSniffCadFormat = rustSniffCadFormat;
  root.rustPlanCadChunks = rustPlanCadChunks;
  root.rustDecodeB64At = rustDecodeB64At;
  root.rustFnv1a64 = rustFnv1a64;
  root.rustCadColorOrder = rustCadColorOrder;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      RustCore: api,
      rustResumePlan,
      rustSchedFollowToday,
      rustDateIsAuto,
      rustDraftKeepsDate,
      rustDeviceIdOk,
      rustValueFix,
      rustB64ToBytes,
      rustBytesToB64,
      rustSniffImageMime,
      rustLooksLikePdf,
      rustPlanTiles,
      rustPackThumbBundle: packThumbBundle,
      rustUnpackThumbBundle: unpackThumbBundle,
      rustSniffCadFormat,
      rustPlanCadChunks,
      rustDecodeB64At,
      rustFnv1a64,
      rustCadColorOrder,
    };
  }

  if (typeof document !== 'undefined' || (typeof self !== 'undefined' && typeof WorkerGlobalScope !== 'undefined')) {
    ensureRustWasm();
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
