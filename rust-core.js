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
      const srcBytes = textEnc.encode(clean);
      const srcLen = srcBytes.byteLength;
      const dstCap = wasm.wasm_b64_decoded_cap(srcLen);
      const srcPtr = wasm.wasm_alloc(srcLen);
      const dstPtr = wasm.wasm_alloc(dstCap);
      if (srcPtr && dstPtr) {
        try {
          new Uint8Array(wasm.memory.buffer, srcPtr, srcLen).set(srcBytes);
          const written = wasm.wasm_b64_decode(srcPtr, srcLen, dstPtr, dstCap);
          if (written !== 0xFFFFFFFF && written <= dstCap) {
            return new Uint8Array(wasm.memory.buffer.slice(dstPtr, dstPtr + written));
          }
        } finally {
          wasm.wasm_dealloc(srcPtr, srcLen);
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

  const api = {
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
  };

  root.RustCore = api;
  root.rustB64ToBytes = rustB64ToBytes;
  root.rustBytesToB64 = rustBytesToB64;
  root.rustSniffImageMime = rustSniffImageMime;
  root.rustLooksLikePdf = rustLooksLikePdf;
  root.rustPlanTiles = rustPlanTiles;
  root.rustPackThumbBundle = packThumbBundle;
  root.rustUnpackThumbBundle = unpackThumbBundle;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      RustCore: api,
      rustB64ToBytes,
      rustBytesToB64,
      rustSniffImageMime,
      rustLooksLikePdf,
      rustPlanTiles,
      rustPackThumbBundle: packThumbBundle,
      rustUnpackThumbBundle: unpackThumbBundle,
    };
  }

  if (typeof document !== 'undefined' || (typeof self !== 'undefined' && typeof WorkerGlobalScope !== 'undefined')) {
    ensureRustWasm();
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
