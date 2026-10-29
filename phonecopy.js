// 사진 사본을 이 폰에도 남긴다.
// - 안드로이드 앱(APK)에서 열었을 때: 네이티브 브리지(window.AndroidGallery.savePhoto)를 통해
//   폰 갤러리의 'Pictures/계측사진/<현장명>/' 폴더에 직접 저장한다.
// - 일반 웹브라우저에서 열었을 때: 웹앱은 폰의 폴더를 직접 만들 수 없으므로
//   파일 이름 맨 앞에 현장 이름을 붙여 '다운로드' 폴더에 저장한다. 예: 당산동_신축공사_20261020_153012_1.jpg
// 이 파일은 app.js보다 먼저 읽히므로 화면 요소($)는 함수가 불릴 때만 쓴다.

const NO_SITE_NAME = '현장무관';
const MAX_NAME_PART = 40;
const DOWNLOAD_GAP_MS = 400;   // 연달아 내려받을 때 브라우저가 막지 않도록 간격을 둔다
const EXT_BY_TYPE = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' };

const safeFilePart = (s) => String(s ?? '').trim().replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, MAX_NAME_PART);

function phoneFileName(site, now, index, mime) {
  const date = now.toLocaleDateString('sv-SE').replaceAll('-', '');
  const time = now.toTimeString().slice(0, 8).replaceAll(':', '');
  return `${safeFilePart(site) || NO_SITE_NAME}_${date}_${time}_${index + 1}.${EXT_BY_TYPE[mime] ?? 'jpg'}`;
}

function phoneAlbumFolder(site) {
  return safeFilePart(site) || NO_SITE_NAME;
}

// 클라우드로 보내는 것과 같은 압축본(150KB 이하 JPEG, base64)을 파일 조각으로 되돌린다
function base64ToBlob(base64, mime = 'image/jpeg') {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// 브라우저에서 파일을 다운로드 폴더로 내려받는다
function downloadBlob(blob, fileName) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 30000);
}

const DRAWING_ALBUM = '도면';

// 폰 갤러리에 같은 이름으로 다시 저장하면 안드로이드가 지우지 않고 '이름 (1).jpg'로 하나 더 만든다.
// 그래서 폴더/이름마다 마지막에 저장한 그림의 지문(해시)을 이 폰에 적어 두고, 그림이 같으면 다시 저장하지 않는다.
// ponytail: 갤러리에서 손으로 지운 파일도 '있음'으로 본다. 이름에 날짜가 들어 있어 다음 날엔 새로 저장된다
const PHONE_SAVED_KEY = 'phoneSavedSigs';
const MAX_PHONE_SAVED = 500;

// 문자열 지문(FNV-1a 32비트) + 길이. 같은 쪽을 같은 메모로 그리면 같은 JPG가 나오므로 같은 값이 된다
function fingerprint(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${text.length}:${h.toString(16)}`;
}

function readPhoneSaved() {
  try { return JSON.parse(localStorage.getItem(PHONE_SAVED_KEY) || '{}') || {}; } catch { return {}; }
}

function writePhoneSaved(map) {
  const keys = Object.keys(map);
  const kept = Object.fromEntries(keys.slice(Math.max(0, keys.length - MAX_PHONE_SAVED)).map((k) => [k, map[k]]));   // 오래된 것부터 버린다
  try { localStorage.setItem(PHONE_SAVED_KEY, JSON.stringify(kept)); } catch { /* 못 적어도 저장 자체는 된다 */ }
}

// 도면 PDF를 이 폰에도 저장한다. files: [{ name, base64, folder }] (folder는 현장 폴더 아래 하위 폴더, 없으면 '')
// - 안드로이드 앱: 앱의 사진 저장 기능은 JPG만 받으므로 쪽마다 JPG로 바꿔(toJpegs) 갤러리 '계측사진/<현장>/도면/<folder>/'에 저장
//   (새 APK 없이 화면 새로고침만으로 되게 하려고 기존 savePhoto를 쓴다)
// - 브라우저: PDF 그대로 다운로드 폴더에. { saved, total, same } 파일 수를 돌려준다(same: 폰에 같은 그림이 이미 있어 건너뛴 수, saved에 포함)
async function savePdfsToPhone(files, site, toJpegs) {
  const bridge = typeof window !== 'undefined' && window.AndroidGallery && typeof window.AndroidGallery.savePhoto === 'function'
    ? window.AndroidGallery
    : null;
  let saved = 0;
  let total = 0;
  let same = 0;
  const done = readPhoneSaved();
  for (const [i, f] of files.entries()) {
    if (bridge) {
      const folder = [phoneAlbumFolder(site), DRAWING_ALBUM, f.folder].filter(Boolean).join('/');
      const stem = f.name.replace(/\.pdf$/i, '');
      let pages = [];
      try { pages = await toJpegs(f.base64); } catch (err) { console.warn('도면 그림 만들기 실패', err); total += 1; continue; }
      total += pages.length;
      for (const [p, jpg] of pages.entries()) {
        const name = pages.length > 1 ? `${stem}_${p + 1}쪽.jpg` : `${stem}.jpg`;
        const key = `${folder}/${name}`;
        const sig = fingerprint(jpg);
        if (done[key] === sig) { saved += 1; same += 1; continue; }
        try {
          if (bridge.savePhoto(jpg, folder, name)) {
            saved += 1;
            delete done[key];   // 새로 적어 맨 뒤(가장 최근)로
            done[key] = sig;
          }
        } catch (err) { console.warn('갤러리 저장 오류', err); }
      }
      writePhoneSaved(done);
      continue;
    }
    total += 1;
    downloadBlob(base64ToBlob(f.base64, 'application/pdf'), f.name);
    saved += 1;
    if (i < files.length - 1) await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_GAP_MS));
  }
  return { saved, total, same };
}

// photos: readPhotos()가 만든 [{ base64 }]. 원본이 아니라 압축본을 저장하므로 폰과 클라우드의 파일이 같다
async function saveCopiesToPhone(photos, site) {
  const now = new Date();
  const nativeBridge = typeof window !== 'undefined' && window.AndroidGallery && typeof window.AndroidGallery.savePhoto === 'function'
    ? window.AndroidGallery
    : null;
  const folder = phoneAlbumFolder(site);
  for (const [i, photo] of photos.entries()) {
    const fileName = phoneFileName(site, now, i, 'image/jpeg');
    if (nativeBridge) {
      // 앱(Java)은 실패하면 false를 돌려준다. 한 장이 실패해도 나머지는 계속 저장한다
      let ok = false;
      try { ok = nativeBridge.savePhoto(photo.base64, folder, fileName); } catch (err) { console.warn('갤러리 저장 오류', err); }
      if (!ok) console.warn(`갤러리 저장 실패: ${fileName}`);
      continue;
    }
    downloadBlob(base64ToBlob(photo.base64), fileName);
    if (i < photos.length - 1) await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_GAP_MS));
  }
}

if (typeof module !== 'undefined') module.exports = { safeFilePart, phoneFileName, phoneAlbumFolder, base64ToBlob, savePdfsToPhone, fingerprint };
