const WIN_RESERVED_NAMES: &[&str] = &[
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

const B64_ENC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const fn build_b64_dec_table() -> [u8; 256] {
    let mut table = [0xFFu8; 256];
    let mut i = 0usize;
    while i < 64 {
        table[B64_ENC[i] as usize] = i as u8;
        i += 1;
    }
    table[b'-' as usize] = 62;
    table[b'_' as usize] = 63;
    table[b'=' as usize] = 0xFE;
    table[b' ' as usize] = 0xFD;
    table[b'\t' as usize] = 0xFD;
    table[b'\r' as usize] = 0xFD;
    table[b'\n' as usize] = 0xFD;
    table
}

const B64_DEC: [u8; 256] = build_b64_dec_table();

pub fn sanitize_filename_core(name: &str, max_len: usize) -> String {
    let mut s: String = name
        .chars()
        .map(|c| {
            if "\\/:*?\"<>|".contains(c) || (c as u32) < 32 {
                '_'
            } else {
                c
            }
        })
        .collect();
    s = s.trim().trim_end_matches(['.', ' ']).to_string();
    if s.is_empty() {
        return "file".to_string();
    }

    let ext = match s.rfind('.') {
        Some(idx) if s.len() - idx <= 10 && idx > 0 => &s[idx..],
        _ => "",
    };
    let mut stem = s[..s.len() - ext.len()].to_string();
    let first_seg = stem.split('.').next().unwrap_or("").to_uppercase();
    if WIN_RESERVED_NAMES.contains(&first_seg.as_str()) {
        stem = format!("_{}", stem);
    }
    if stem.len() + ext.len() > max_len {
        let keep = max_len.saturating_sub(ext.len()).max(1);
        stem = stem
            .chars()
            .take(keep)
            .collect::<String>()
            .trim_end_matches(['.', ' '])
            .to_string();
        if stem.is_empty() {
            stem = "_".to_string();
        }
    }
    format!("{}{}", stem, ext)
}

/// Fast LUT Base64 decoder with 4-byte unrolled SIMD-friendly fast path. Returns `None` on malformed input.
pub fn b64_decode_into(src: &[u8], dst: &mut [u8]) -> Option<usize> {
    let mut out = 0usize;
    let mut idx = 0usize;

    // 4-byte unrolled fast path for contiguous non-padded Base64 quadruplets
    while idx + 4 <= src.len() && out + 3 <= dst.len() {
        let v0 = B64_DEC[src[idx] as usize];
        let v1 = B64_DEC[src[idx + 1] as usize];
        let v2 = B64_DEC[src[idx + 2] as usize];
        let v3 = B64_DEC[src[idx + 3] as usize];
        if (v0 | v1 | v2 | v3) >= 64 {
            break;
        }
        let triple = ((v0 as u32) << 18) | ((v1 as u32) << 12) | ((v2 as u32) << 6) | (v3 as u32);
        dst[out] = (triple >> 16) as u8;
        dst[out + 1] = (triple >> 8) as u8;
        dst[out + 2] = triple as u8;
        idx += 4;
        out += 3;
    }

    let mut buf = [0u8; 4];
    let mut count = 0usize;
    let mut pad = 0usize;

    for (rem_offset, &b) in src[idx..].iter().enumerate() {
        let cur_idx = idx + rem_offset;
        let v = B64_DEC[b as usize];
        if v == 0xFD {
            continue;
        }
        if v == 0xFF {
            return None;
        }
        if v == 0xFE {
            pad += 1;
            buf[count] = 0;
        } else {
            if pad > 0 {
                return None;
            }
            buf[count] = v;
        }
        count += 1;
        if count == 4 {
            let n = match pad {
                0 => 3,
                1 => 2,
                2 => 1,
                _ => return None,
            };
            if out + n > dst.len() {
                return None;
            }
            dst[out] = (buf[0] << 2) | (buf[1] >> 4);
            if n > 1 {
                dst[out + 1] = (buf[1] << 4) | (buf[2] >> 2);
            }
            if n > 2 {
                dst[out + 2] = (buf[2] << 6) | buf[3];
            }
            out += n;
            count = 0;
            if pad > 0 {
                for &rem in &src[cur_idx + 1..] {
                    if B64_DEC[rem as usize] != 0xFD {
                        return None;
                    }
                }
                break;
            }
        }
    }

    if count != 0 {
        if pad > 0 || count == 1 {
            return None;
        }
        let n = count - 1;
        if out + n > dst.len() {
            return None;
        }
        dst[out] = (buf[0] << 2) | (buf[1] >> 4);
        if n > 1 {
            dst[out + 1] = (buf[1] << 4) | (buf[2] >> 2);
        }
        out += n;
    }

    Some(out)
}

pub fn b64_decode_vec(src: &[u8]) -> Option<Vec<u8>> {
    let cap = (src.len() / 4 + 1) * 3;
    let mut dst = vec![0u8; cap];
    let len = b64_decode_into(src, &mut dst)?;
    dst.truncate(len);
    Some(dst)
}

pub fn b64_encode_into(src: &[u8], dst: &mut [u8]) -> Option<usize> {
    let needed = src.len().div_ceil(3) * 4;
    if dst.len() < needed {
        return None;
    }
    let mut i = 0usize;
    let mut o = 0usize;
    while i + 3 <= src.len() {
        let b0 = src[i] as usize;
        let b1 = src[i + 1] as usize;
        let b2 = src[i + 2] as usize;
        dst[o] = B64_ENC[b0 >> 2];
        dst[o + 1] = B64_ENC[((b0 & 0x03) << 4) | (b1 >> 4)];
        dst[o + 2] = B64_ENC[((b1 & 0x0F) << 2) | (b2 >> 6)];
        dst[o + 3] = B64_ENC[b2 & 0x3F];
        i += 3;
        o += 4;
    }
    let rem = src.len() - i;
    if rem == 1 {
        let b0 = src[i] as usize;
        dst[o] = B64_ENC[b0 >> 2];
        dst[o + 1] = B64_ENC[(b0 & 0x03) << 4];
        dst[o + 2] = b'=';
        dst[o + 3] = b'=';
        o += 4;
    } else if rem == 2 {
        let b0 = src[i] as usize;
        let b1 = src[i + 1] as usize;
        dst[o] = B64_ENC[b0 >> 2];
        dst[o + 1] = B64_ENC[((b0 & 0x03) << 4) | (b1 >> 4)];
        dst[o + 2] = B64_ENC[(b1 & 0x0F) << 2];
        dst[o + 3] = b'=';
        o += 4;
    }
    Some(o)
}

/// 1 = image/jpeg, 2 = image/png, 3 = image/webp, 4 = application/pdf, 0 = unknown
pub fn sniff_mime_code(bytes: &[u8]) -> u8 {
    if bytes.len() >= 4 {
        if bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47 {
            return 2;
        }
        if bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x46 {
            return 3;
        }
        if bytes[0] == 0xFF && bytes[1] == 0xD8 {
            return 1;
        }
    }
    if looks_like_pdf_core(bytes) {
        return 4;
    }
    0
}

pub fn sniff_image_mime_str(bytes: &[u8]) -> &'static str {
    match sniff_mime_code(bytes) {
        2 => "image/png",
        3 => "image/webp",
        _ => "image/jpeg",
    }
}

pub fn looks_like_pdf_core(bytes: &[u8]) -> bool {
    let limit = bytes.len().min(1024);
    if limit < 4 {
        return false;
    }
    for i in 0..=(limit - 4) {
        if bytes[i] == 0x25
            && bytes[i + 1] == 0x50
            && bytes[i + 2] == 0x44
            && bytes[i + 3] == 0x46
        {
            return true;
        }
    }
    false
}

/// Plans visible tiles for high-res PDF rendering, sorted by distance to viewport center.
/// Writes `[col, row, x, y, w, h]` (6 x i32 per tile) into `out` and returns the number of tiles.
#[allow(clippy::too_many_arguments)]
pub fn plan_visible_tiles_into(
    css_w: f64,
    css_h: f64,
    dpr: f64,
    tile_px: i32,
    vx0: f64,
    vy0: f64,
    vx1: f64,
    vy1: f64,
    pad: f64,
    out: &mut [i32],
) -> usize {
    if !(css_w > 0.0 && css_h > 0.0 && dpr > 0.0 && tile_px > 0) {
        return 0;
    }
    let full_w = (css_w * dpr).round().max(1.0) as i32;
    let full_h = (css_h * dpr).round().max(1.0) as i32;
    let x0 = (((vx0 - pad) * dpr).floor() as i32).clamp(0, full_w);
    let y0 = (((vy0 - pad) * dpr).floor() as i32).clamp(0, full_h);
    let x1 = (((vx1 + pad) * dpr).ceil() as i32).clamp(0, full_w);
    let y1 = (((vy1 + pad) * dpr).ceil() as i32).clamp(0, full_h);
    if x1 <= x0 || y1 <= y0 {
        return 0;
    }
    let c0 = x0 / tile_px;
    let r0 = y0 / tile_px;
    let c1 = (x1 - 1) / tile_px;
    let r1 = (y1 - 1) / tile_px;
    let cx = ((vx0 + vx1) * 0.5 * dpr) as i64;
    let cy = ((vy0 + vy1) * 0.5 * dpr) as i64;

    let max_tiles = out.len() / 6;
    let mut tiles: Vec<(i64, [i32; 6])> = Vec::new();
    for r in r0..=r1 {
        for c in c0..=c1 {
            let tx = c * tile_px;
            let ty = r * tile_px;
            let tw = (full_w - tx).min(tile_px);
            let th = (full_h - ty).min(tile_px);
            if tw <= 0 || th <= 0 {
                continue;
            }
            let mx = (tx + tw / 2) as i64 - cx;
            let my = (ty + th / 2) as i64 - cy;
            let dist2 = mx * mx + my * my;
            tiles.push((dist2, [c, r, tx, ty, tw, th]));
        }
    }
    tiles.sort_by_key(|t| t.0);
    let count = tiles.len().min(max_tiles);
    for (i, (_, t)) in tiles.into_iter().take(count).enumerate() {
        let base = i * 6;
        out[base..base + 6].copy_from_slice(&t);
    }
    count
}

/// Inspects CAD header bytes:
/// 1 = Modern DWG (AC1015..AC1032, R2000..R2018+ supported natively by Rust acadrust/cadpocket)
/// 2 = Legacy DWG (AC1012/AC1014 R13/R14 or older, requires libredwg fallback)
/// 3 = DXF (ASCII or Binary DXF)
/// 0 = Unknown
pub fn sniff_cad_format_core(bytes: &[u8]) -> u8 {
    if bytes.len() >= 6 && &bytes[0..2] == b"AC" {
        return match &bytes[0..6] {
            b"AC1015" | b"AC1018" | b"AC1021" | b"AC1024" | b"AC1027" | b"AC1032" => 1,
            b"AC1014" | b"AC1012" | b"AC1009" | b"AC1006" | b"AC1004" | b"AC1003"
            | b"AC1002" | b"AC1.50" | b"AC2.10" => 2,
            _ => 1,
        };
    }
    if bytes.len() >= 18 && &bytes[0..18] == b"AutoCAD Binary DXF" {
        return 3;
    }
    let head_len = bytes.len().min(256);
    let head = &bytes[..head_len];
    let mut i = 0usize;
    while i < head.len()
        && (head[i] == b' '
            || head[i] == b'\t'
            || head[i] == b'\r'
            || head[i] == b'\n'
            || head[i] == 0xEF
            || head[i] == 0xBB
            || head[i] == 0xBF)
    {
        i += 1;
    }
    if i < head.len() && (head[i] == b'0' || head[i..].starts_with(b"999")) {
        for w in head[i..].windows(7) {
            if w.eq_ignore_ascii_case(b"SECTION") || w.eq_ignore_ascii_case(b"ENTITIE") {
                return 3;
            }
        }
    }
    0
}

/// Plans parallel DWG/DXF download chunks `[offset, length, index]` (3 x u32 per chunk).
pub fn plan_cad_chunks_into(
    total_size: u32,
    chunk_size: u32,
    start_offset: u32,
    out: &mut [u32],
) -> usize {
    if chunk_size == 0 || start_offset >= total_size {
        return 0;
    }
    let max_chunks = out.len() / 3;
    let mut at = start_offset;
    let mut idx = start_offset / chunk_size;
    let mut count = 0usize;
    while at < total_size && count < max_chunks {
        let len = (total_size - at).min(chunk_size);
        let base = count * 3;
        out[base] = at;
        out[base + 1] = len;
        out[base + 2] = idx;
        at = at.saturating_add(len);
        idx += 1;
        count += 1;
    }
    count
}

/// Fast 64-bit FNV-1a hash for DWG/DXF binary fingerprinting and cache validation.
pub fn fnv1a64_core(bytes: &[u8]) -> u64 {
    const OFFSET_BASIS: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x00000100000001b3;
    let mut h = OFFSET_BASIS;
    let mut i = 0usize;
    while i + 8 <= bytes.len() {
        h ^= bytes[i] as u64;
        h = h.wrapping_mul(PRIME);
        h ^= bytes[i + 1] as u64;
        h = h.wrapping_mul(PRIME);
        h ^= bytes[i + 2] as u64;
        h = h.wrapping_mul(PRIME);
        h ^= bytes[i + 3] as u64;
        h = h.wrapping_mul(PRIME);
        h ^= bytes[i + 4] as u64;
        h = h.wrapping_mul(PRIME);
        h ^= bytes[i + 5] as u64;
        h = h.wrapping_mul(PRIME);
        h ^= bytes[i + 6] as u64;
        h = h.wrapping_mul(PRIME);
        h ^= bytes[i + 7] as u64;
        h = h.wrapping_mul(PRIME);
        i += 8;
    }
    while i < bytes.len() {
        h ^= bytes[i] as u64;
        h = h.wrapping_mul(PRIME);
        i += 1;
    }
    h
}

/// Groups polyline indices by their 32-bit RGB color in order of first appearance.
/// Writes unique colors into `out_colors`, group lengths into `out_counts`, and flat polyline indices into `out_indices`.
/// Returns number of unique color groups (or `usize::MAX` if unique colors exceed `out_colors.len()`).
pub fn cad_color_order_into(
    colors: &[u32],
    out_colors: &mut [u32],
    out_counts: &mut [u32],
    out_indices: &mut [u32],
) -> usize {
    let n = colors.len();
    if n == 0 {
        return 0;
    }
    if out_indices.len() < n {
        return usize::MAX;
    }
    let max_groups = out_colors.len().min(out_counts.len());
    if max_groups == 0 {
        return usize::MAX;
    }
    // Open-addressing hash table over group slots (power-of-two capacity)
    let cap = (max_groups * 2).next_power_of_two().max(64);
    let mask = cap - 1;
    let mut slot_key = vec![u32::MAX; cap];
    let mut slot_grp = vec![u32::MAX; cap];
    let mut poly_grp = vec![0u32; n];
    let mut num_groups = 0usize;

    for (i, &c) in colors.iter().enumerate() {
        let mut h = (c.wrapping_mul(0x9E3779B9) as usize) & mask;
        let grp = loop {
            let g = slot_grp[h];
            if g == u32::MAX {
                if num_groups >= max_groups {
                    return usize::MAX;
                }
                let new_g = num_groups as u32;
                slot_key[h] = c;
                slot_grp[h] = new_g;
                out_colors[num_groups] = c;
                out_counts[num_groups] = 0;
                num_groups += 1;
                break new_g;
            }
            if slot_key[h] == c {
                break g;
            }
            h = (h + 1) & mask;
        };
        poly_grp[i] = grp;
        out_counts[grp as usize] += 1;
    }

    let mut offsets = vec![0u32; num_groups];
    let mut acc = 0u32;
    for g in 0..num_groups {
        offsets[g] = acc;
        acc += out_counts[g];
    }
    for (i, &g) in poly_grp.iter().enumerate() {
        let pos = offsets[g as usize] as usize;
        out_indices[pos] = i as u32;
        offsets[g as usize] += 1;
    }
    num_groups
}

// ============================================================================
// C / WebAssembly ABI exports (`wasm32-unknown-unknown` & native)
// ============================================================================

#[no_mangle]
pub extern "C" fn wasm_alloc(size: usize) -> *mut u8 {
    if size == 0 {
        return core::ptr::null_mut();
    }
    let mut buf = Vec::<u8>::with_capacity(size);
    let ptr = buf.as_mut_ptr();
    core::mem::forget(buf);
    ptr
}

#[no_mangle]
/// # Safety
/// `ptr` and `size` must come from a previous `wasm_alloc(size)` call.
pub unsafe extern "C" fn wasm_dealloc(ptr: *mut u8, size: usize) {
    if !ptr.is_null() && size > 0 {
        drop(Vec::from_raw_parts(ptr, 0, size));
    }
}

#[no_mangle]
pub extern "C" fn wasm_b64_decoded_cap(src_len: usize) -> usize {
    (src_len / 4 + 1) * 3
}

#[no_mangle]
pub extern "C" fn wasm_b64_encoded_len(src_len: usize) -> usize {
    src_len.div_ceil(3) * 4
}

#[no_mangle]
/// # Safety
/// `src_ptr..src_ptr+src_len` and `dst_ptr..dst_ptr+dst_cap` must be valid slices in linear memory.
pub unsafe extern "C" fn wasm_b64_decode(
    src_ptr: *const u8,
    src_len: usize,
    dst_ptr: *mut u8,
    dst_cap: usize,
) -> usize {
    if src_ptr.is_null() || (dst_ptr.is_null() && dst_cap > 0) {
        return usize::MAX;
    }
    let src = core::slice::from_raw_parts(src_ptr, src_len);
    let dst = core::slice::from_raw_parts_mut(dst_ptr, dst_cap);
    b64_decode_into(src, dst).unwrap_or(usize::MAX)
}

#[no_mangle]
/// # Safety
/// `src_ptr..src_ptr+src_len` and `dst_ptr..dst_ptr+dst_cap` must be valid slices in linear memory.
pub unsafe extern "C" fn wasm_b64_encode(
    src_ptr: *const u8,
    src_len: usize,
    dst_ptr: *mut u8,
    dst_cap: usize,
) -> usize {
    if src_ptr.is_null() || (dst_ptr.is_null() && dst_cap > 0) {
        return usize::MAX;
    }
    let src = core::slice::from_raw_parts(src_ptr, src_len);
    let dst = core::slice::from_raw_parts_mut(dst_ptr, dst_cap);
    b64_encode_into(src, dst).unwrap_or(usize::MAX)
}

#[no_mangle]
/// # Safety
/// `ptr..ptr+len` must be a valid slice in linear memory.
pub unsafe extern "C" fn wasm_sniff_mime(ptr: *const u8, len: usize) -> u32 {
    if ptr.is_null() || len == 0 {
        return 0;
    }
    sniff_mime_code(core::slice::from_raw_parts(ptr, len)) as u32
}

#[no_mangle]
/// # Safety
/// `ptr..ptr+len` must be a valid slice in linear memory.
pub unsafe extern "C" fn wasm_looks_like_pdf(ptr: *const u8, len: usize) -> u32 {
    if ptr.is_null() || len < 4 {
        return 0;
    }
    u32::from(looks_like_pdf_core(core::slice::from_raw_parts(ptr, len)))
}

#[no_mangle]
/// # Safety
/// `out_ptr` must point to at least `max_tiles * 6` `i32` elements.
pub unsafe extern "C" fn wasm_plan_tiles(
    css_w: f64,
    css_h: f64,
    dpr: f64,
    tile_px: i32,
    vx0: f64,
    vy0: f64,
    vx1: f64,
    vy1: f64,
    pad: f64,
    out_ptr: *mut i32,
    max_tiles: usize,
) -> usize {
    if out_ptr.is_null() || max_tiles == 0 {
        return 0;
    }
    let out = core::slice::from_raw_parts_mut(out_ptr, max_tiles * 6);
    plan_visible_tiles_into(css_w, css_h, dpr, tile_px, vx0, vy0, vx1, vy1, pad, out)
}

#[no_mangle]
/// # Safety
/// `ptr..ptr+len` must be a valid slice in linear memory.
pub unsafe extern "C" fn wasm_sniff_cad_format(ptr: *const u8, len: usize) -> u32 {
    if ptr.is_null() || len == 0 {
        return 0;
    }
    sniff_cad_format_core(core::slice::from_raw_parts(ptr, len)) as u32
}

#[no_mangle]
/// # Safety
/// `out_ptr` must point to at least `max_chunks * 3` `u32` elements.
pub unsafe extern "C" fn wasm_plan_cad_chunks(
    total_size: u32,
    chunk_size: u32,
    start_offset: u32,
    out_ptr: *mut u32,
    max_chunks: usize,
) -> usize {
    if out_ptr.is_null() || max_chunks == 0 {
        return 0;
    }
    let out = core::slice::from_raw_parts_mut(out_ptr, max_chunks * 3);
    plan_cad_chunks_into(total_size, chunk_size, start_offset, out)
}

#[no_mangle]
/// # Safety
/// `src_ptr..src_ptr+src_len` and `dst_ptr..dst_ptr+dst_total` must be valid slices in linear memory.
pub unsafe extern "C" fn wasm_b64_decode_at(
    src_ptr: *const u8,
    src_len: usize,
    dst_ptr: *mut u8,
    dst_total: usize,
    offset: usize,
) -> usize {
    if src_ptr.is_null() || dst_ptr.is_null() || offset >= dst_total {
        return usize::MAX;
    }
    let src = core::slice::from_raw_parts(src_ptr, src_len);
    let dst = core::slice::from_raw_parts_mut(dst_ptr.add(offset), dst_total - offset);
    b64_decode_into(src, dst).unwrap_or(usize::MAX)
}

#[no_mangle]
/// # Safety
/// `ptr..ptr+len` must be a valid slice in linear memory.
pub unsafe extern "C" fn wasm_fnv1a64(ptr: *const u8, len: usize) -> u64 {
    if ptr.is_null() || len == 0 {
        return 0;
    }
    fnv1a64_core(core::slice::from_raw_parts(ptr, len))
}

#[no_mangle]
/// # Safety
/// `colors_ptr`, `out_colors_ptr`, `out_counts_ptr`, and `out_indices_ptr` must be valid slices in linear memory.
pub unsafe extern "C" fn wasm_cad_color_order(
    colors_ptr: *const u32,
    n: usize,
    out_colors_ptr: *mut u32,
    out_counts_ptr: *mut u32,
    out_indices_ptr: *mut u32,
    max_groups: usize,
) -> usize {
    if colors_ptr.is_null()
        || out_colors_ptr.is_null()
        || out_counts_ptr.is_null()
        || out_indices_ptr.is_null()
        || n == 0
        || max_groups == 0
    {
        return 0;
    }
    let colors = core::slice::from_raw_parts(colors_ptr, n);
    let out_colors = core::slice::from_raw_parts_mut(out_colors_ptr, max_groups);
    let out_counts = core::slice::from_raw_parts_mut(out_counts_ptr, max_groups);
    let out_indices = core::slice::from_raw_parts_mut(out_indices_ptr, n);
    cad_color_order_into(colors, out_colors, out_counts, out_indices)
}

// ============================================================================
// Android JNI exports (non-wasm32 targets)
// ============================================================================

#[cfg(not(target_arch = "wasm32"))]
mod jni_bridge {
    use super::*;
    use jni::objects::{JByteArray, JClass, JString};
    use jni::sys::{jboolean, jbyteArray, jint, jlong, jstring, JNI_FALSE, JNI_TRUE};
    use jni::JNIEnv;
    use serde_json::json;

    #[no_mangle]
    pub extern "system" fn Java_com_kiwoomenc_gyecheuk_RustCore_ping<'local>(
        env: JNIEnv<'local>,
        _class: JClass<'local>,
    ) -> jstring {
        let payload = json!({
            "ok": true,
            "engine": "gyecheuk-android-core",
            "version": env!("CARGO_PKG_VERSION")
        })
        .to_string();
        env.new_string(payload)
            .expect("Failed to create JNI string")
            .into_raw()
    }

    #[no_mangle]
    pub extern "system" fn Java_com_kiwoomenc_gyecheuk_RustCore_sanitizeFilename<'local>(
        mut env: JNIEnv<'local>,
        _class: JClass<'local>,
        input: JString<'local>,
    ) -> jstring {
        let raw: String = env
            .get_string(&input)
            .map(|s| s.into())
            .unwrap_or_default();
        let out = sanitize_filename_core(&raw, 150);
        env.new_string(out)
            .expect("Failed to create JNI string")
            .into_raw()
    }

    #[no_mangle]
    pub extern "system" fn Java_com_kiwoomenc_gyecheuk_RustCore_decodeBase64<'local>(
        mut env: JNIEnv<'local>,
        _class: JClass<'local>,
        input: JString<'local>,
    ) -> jbyteArray {
        let raw: String = env
            .get_string(&input)
            .map(|s| s.into())
            .unwrap_or_default();
        let decoded = b64_decode_vec(raw.as_bytes()).unwrap_or_default();
        env.byte_array_from_slice(&decoded)
            .expect("Failed to create JNI byte array")
            .into_raw()
    }

    #[no_mangle]
    pub extern "system" fn Java_com_kiwoomenc_gyecheuk_RustCore_looksLikePdf<'local>(
        env: JNIEnv<'local>,
        _class: JClass<'local>,
        data: JByteArray<'local>,
    ) -> jboolean {
        let bytes = env.convert_byte_array(data).unwrap_or_default();
        if looks_like_pdf_core(&bytes) {
            JNI_TRUE
        } else {
            JNI_FALSE
        }
    }

    #[no_mangle]
    pub extern "system" fn Java_com_kiwoomenc_gyecheuk_RustCore_sniffImageMime<'local>(
        env: JNIEnv<'local>,
        _class: JClass<'local>,
        data: JByteArray<'local>,
    ) -> jstring {
        let bytes = env.convert_byte_array(data).unwrap_or_default();
        let mime = sniff_image_mime_str(&bytes);
        env.new_string(mime)
            .expect("Failed to create JNI string")
            .into_raw()
    }

    #[no_mangle]
    pub extern "system" fn Java_com_kiwoomenc_gyecheuk_RustCore_sniffCadFormat<'local>(
        env: JNIEnv<'local>,
        _class: JClass<'local>,
        data: JByteArray<'local>,
    ) -> jint {
        let bytes = env.convert_byte_array(data).unwrap_or_default();
        sniff_cad_format_core(&bytes) as jint
    }

    #[no_mangle]
    pub extern "system" fn Java_com_kiwoomenc_gyecheuk_RustCore_fnv1a64<'local>(
        env: JNIEnv<'local>,
        _class: JClass<'local>,
        data: JByteArray<'local>,
    ) -> jlong {
        let bytes = env.convert_byte_array(data).unwrap_or_default();
        fnv1a64_core(&bytes) as jlong
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sanitize_filename() {
        assert_eq!(sanitize_filename_core("도면:1/2?.pdf", 150), "도면_1_2_.pdf");
        assert_eq!(sanitize_filename_core("CON.txt", 150), "_CON.txt");
        assert_eq!(sanitize_filename_core("   ", 150), "file");
    }

    #[test]
    fn test_b64_roundtrip_and_whitespace() {
        let orig: Vec<u8> = (0..=255).chain(0..100).collect();
        let mut enc = vec![0u8; wasm_b64_encoded_len(orig.len())];
        let enc_len = b64_encode_into(&orig, &mut enc).unwrap();
        let dec = b64_decode_vec(&enc[..enc_len]).unwrap();
        assert_eq!(dec, orig);

        // URL-safe & whitespace tolerance
        let with_ws = b" \r\n SGVs bG8t d29y bGQ_ \t ";
        let d2 = b64_decode_vec(with_ws).unwrap();
        assert_eq!(&d2, b"Hello-world?");
        assert!(b64_decode_vec(b"bad===base64!").is_none());
    }

    #[test]
    fn test_mime_and_pdf_sniff() {
        assert_eq!(sniff_mime_code(&[0xFF, 0xD8, 0xFF, 0xE0]), 1);
        assert_eq!(sniff_mime_code(&[0x89, 0x50, 0x4E, 0x47]), 2);
        assert_eq!(sniff_mime_code(b"RIFF\x00\x00\x00\x00WEBP"), 3);
        assert!(looks_like_pdf_core(b"\x00\x00%PDF-1.7\n"));
        assert!(!looks_like_pdf_core(b"not a pdf"));
    }

    #[test]
    fn test_plan_visible_tiles_center_first() {
        let mut out = [0i32; 6 * 32];
        let n = plan_visible_tiles_into(1000.0, 1000.0, 2.0, 512, 100.0, 100.0, 900.0, 900.0, 64.0, &mut out);
        assert_eq!(n, 16);
        // Center of 0..2000 is (1000, 1000), so tiles around col 1..2, row 1..2 come first
        let first_col = out[0];
        let first_row = out[1];
        assert!((1..=2).contains(&first_col));
        assert!((1..=2).contains(&first_row));
    }

    #[test]
    fn test_sniff_cad_format() {
        assert_eq!(sniff_cad_format_core(b"AC1032\x00\x00"), 1);
        assert_eq!(sniff_cad_format_core(b"AC1015\x00\x00"), 1);
        assert_eq!(sniff_cad_format_core(b"AC1014\x00\x00"), 2);
        assert_eq!(sniff_cad_format_core(b"AC1012\x00\x00"), 2);
        assert_eq!(sniff_cad_format_core(b"  0\r\nSECTION\r\n  2\r\nHEADER"), 3);
        assert_eq!(sniff_cad_format_core(b"AutoCAD Binary DXF\r\n\x1a\x00"), 3);
        assert_eq!(sniff_cad_format_core(b"random"), 0);
    }

    #[test]
    fn test_plan_cad_chunks() {
        let mut out = [0u32; 3 * 8];
        let n = plan_cad_chunks_into(6_815_744, 4_194_304, 0, &mut out);
        assert_eq!(n, 2);
        assert_eq!(&out[0..6], &[0, 4_194_304, 0, 4_194_304, 2_621_440, 1]);
    }

    #[test]
    fn test_fnv1a64_and_color_order() {
        let h1 = fnv1a64_core(b"AC1032_DWG_SAMPLE_BYTES_12345678");
        let h2 = fnv1a64_core(b"AC1032_DWG_SAMPLE_BYTES_12345679");
        assert_ne!(h1, h2);

        let colors = [0xFF0000u32, 0x00FF00, 0xFF0000, 0x0000FF, 0x00FF00, 0xFF0000];
        let mut out_c = [0u32; 8];
        let mut out_cnt = [0u32; 8];
        let mut out_idx = [0u32; 6];
        let g = cad_color_order_into(&colors, &mut out_c, &mut out_cnt, &mut out_idx);
        assert_eq!(g, 3);
        assert_eq!(&out_c[..3], &[0xFF0000, 0x00FF00, 0x0000FF]);
        assert_eq!(&out_cnt[..3], &[3, 2, 1]);
        assert_eq!(&out_idx, &[0, 2, 5, 1, 4, 3]);
    }
}
