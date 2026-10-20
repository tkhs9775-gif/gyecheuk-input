// 사진 사본을 이 폰에도 남긴다. 웹앱은 폰의 폴더를 직접 만들거나 고를 수 없어서(안드로이드 크롬 제한),
// 파일 이름 맨 앞에 현장 이름을 붙여 '다운로드' 폴더에 저장한다. 예: 당산동_신축공사_20261020_153012_1.jpg
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

// 클라우드로 보내는 것과 같은 압축본(150KB 이하 JPEG, base64)을 파일 조각으로 되돌린다
function base64ToBlob(base64) {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/jpeg' });
}

// photos: readPhotos()가 만든 [{ base64 }]. 원본이 아니라 압축본을 저장하므로 폰과 클라우드의 파일이 같다
async function saveCopiesToPhone(photos, site) {
  const now = new Date();
  for (const [i, photo] of photos.entries()) {
    const blob = base64ToBlob(photo.base64);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = phoneFileName(site, now, i, blob.type);
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 30000);
    if (i < photos.length - 1) await new Promise((resolve) => setTimeout(resolve, DOWNLOAD_GAP_MS));
  }
}

if (typeof module !== 'undefined') module.exports = { safeFilePart, phoneFileName, base64ToBlob };
