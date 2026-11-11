// 현장 담당자 명함(2026-11-11): 도면 탭에서 현장 폴더를 열면 위에 그 현장 담당자 명함 사진이 보인다.
// 명함 앱처럼: 촬영(또는 사진 고르기) → 스캔 화면(card-crop.js: 테두리 맞추기 → 반듯하게 펴기 → 빛 반사·그늘 지우기) → 저장.
// 글자 읽기(OCR)는 쓰지 않는다(반사 재질에서 틀려서). 이름·전화는 적고 싶을 때만 직접 적는다.
// 서버: Code.gs contact_list/save/delete/photo — 시트 '명함' + Drive 명함/<현장>/
// app.js·drawing.js 다음에 읽힌다: $, api, state, store, flash, errorText, signOut, withBusy, show 를 쓴다.

const CONTACT_FIELDS = { name: 'cfName', title: 'cfTitle', company: 'cfCompany', mobile: 'cfMobile', email: 'cfEmail', memo: 'cfMemo' };

const contactState = { site: '', items: [], seq: 0, editing: null, photo: null, clientId: '' };
const contactCacheKey = (site) => `contacts_${site}`;
const contactImgs = new Map();   // `${id}:${photoId}` → data URL (한 번 받은 명함 사진)
const contactImgKey = (c) => `cardimg_${c.id}_${c.photoId}`;

async function contactsOpenSite(site) {
  contactState.site = site;
  const seq = ++contactState.seq;
  const cached = (() => { try { return JSON.parse(store.get(contactCacheKey(site)) || 'null'); } catch { return null; } })();
  contactState.items = Array.isArray(cached) ? cached : [];
  contactsRender(cached ? '' : '불러오는 중...');
  try {
    const { items } = await api('contact_list', { site });
    if (seq !== contactState.seq) return;
    contactState.items = Array.isArray(items) ? items : [];
    store.set(contactCacheKey(site), JSON.stringify(contactState.items));
    contactsRender('');
  } catch (err) {
    if (seq !== contactState.seq) return;
    if (err.isAuth) { signOut(); return; }
    contactsRender(err.code === 'bad_action' ? '서버가 아직 옛 버전입니다(관리자: Code.gs 새 버전 배포).' : (cached ? '' : `명함을 불러오지 못했습니다. ${errorText(err)}`));
  }
}
window.contactsOpenSite = contactsOpenSite;

// 명함 사진 받기: 메모리 → 폰 보관분 → 서버 순. 폰 보관은 자리가 없으면 그냥 건너뛴다
async function contactPhotoUrl(c) {
  if (!c.photoId) return '';
  const key = `${c.id}:${c.photoId}`;
  if (contactImgs.has(key)) return contactImgs.get(key);
  const saved = store.get(contactImgKey(c));
  if (saved) { contactImgs.set(key, saved); return saved; }
  const { base64 } = await api('contact_photo', { id: c.id });
  const url = `data:image/jpeg;base64,${base64}`;
  contactImgs.set(key, url);
  store.set(contactImgKey(c), url);
  return url;
}

const contactCaption = (c) => [c.name, c.title].filter(Boolean).join(' ');

function contactsRender(note) {
  const box = $('contactCards');
  if (!contactState.items.length) {
    const p = document.createElement('p');
    p.className = 'contacts-empty';
    p.textContent = note || '아직 명함이 없습니다. 현장 소장님 명함을 받으면 「＋ 명함」으로 찍어 두세요.';
    box.replaceChildren(p);
    return;
  }
  box.replaceChildren(...contactState.items.map((c) => {
    const fig = document.createElement('figure');
    fig.className = 'biz';
    const shot = document.createElement('button');
    shot.type = 'button';
    shot.className = 'biz-shot loading';
    shot.setAttribute('aria-label', `${contactCaption(c) || '명함'} 크게 보기`);
    const img = document.createElement('img');
    img.alt = `${contactCaption(c) || '현장 담당자'} 명함`;
    shot.append(img);
    if (c.photoId) {
      contactPhotoUrl(c).then((url) => { img.src = url; shot.classList.remove('loading'); }).catch(() => { shot.classList.remove('loading'); shot.classList.add('nophoto'); shot.textContent = '사진을 받지 못했습니다 · 눌러서 다시'; });
    } else {
      shot.classList.remove('loading');
      shot.classList.add('nophoto');
      shot.textContent = '명함 사진 없음 · 눌러서 추가';
    }
    shot.addEventListener('click', () => (c.photoId && img.src ? contactView(c, img.src) : contactOpen(c)));
    const cap = document.createElement('figcaption');
    cap.className = 'biz-cap';
    const who = document.createElement('div');
    who.className = 'biz-who';
    const tag = document.createElement('span');
    tag.className = 'cc-role';
    tag.textContent = '담당자';
    who.append(tag);
    if (contactCaption(c)) { const b = document.createElement('b'); b.textContent = contactCaption(c); who.append(b); }
    if (c.company) { const s = document.createElement('span'); s.className = 'biz-co'; s.textContent = c.company; who.append(s); }
    cap.append(who);
    if (c.mobile) {
      const call = document.createElement('a');
      call.className = 'biz-call';
      call.href = `tel:${c.mobile.replace(/[^\d+]/g, '')}`;
      call.textContent = `📞 ${c.mobile}`;
      cap.append(call);
    }
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'biz-edit';
    edit.setAttribute('aria-label', `${contactCaption(c) || '명함'} 수정`);
    edit.textContent = '수정';
    edit.addEventListener('click', () => contactOpen(c));
    cap.append(edit);
    if (c.memo) { const m = document.createElement('p'); m.className = 'biz-memo'; m.textContent = c.memo; cap.append(m); }
    fig.append(shot, cap);
    return fig;
  }));
}

// 크게 보기: 화면 가득, 두 번 누르거나 [확대]로 실제 크기(밀어서 보기). 안드로이드 뒤로가기로 닫힌다
function contactView(c, url) {
  const wrap = document.createElement('div');
  wrap.className = 'biz-viewer';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.setAttribute('aria-label', '명함 크게 보기');
  const top = document.createElement('div');
  top.className = 'bv-top';
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'bv-btn'; close.textContent = '✕'; close.setAttribute('aria-label', '닫기');
  const title = document.createElement('p');
  title.className = 'bv-title';
  title.textContent = contactCaption(c) || '현장 담당자 명함';
  const zoom = document.createElement('button');
  zoom.type = 'button'; zoom.className = 'bv-btn wide'; zoom.textContent = '🔍 확대';
  top.append(close, title, zoom);
  const stage = document.createElement('div');
  stage.className = 'bv-stage';
  const img = document.createElement('img');
  img.src = url; img.alt = title.textContent;
  stage.append(img);
  const bottom = document.createElement('div');
  bottom.className = 'bv-bottom';
  if (c.mobile) { const a = document.createElement('a'); a.className = 'bv-act call'; a.href = `tel:${c.mobile.replace(/[^\d+]/g, '')}`; a.textContent = `📞 ${c.mobile}`; bottom.append(a); }
  const edit = document.createElement('button');
  edit.type = 'button'; edit.className = 'bv-act'; edit.textContent = '✎ 수정';
  bottom.append(edit);
  wrap.append(top, stage, bottom);
  document.body.append(wrap);
  document.body.classList.add('cam-open');
  let zoomed = false;
  const toggle = () => { zoomed = !zoomed; stage.classList.toggle('zoomed', zoomed); zoom.textContent = zoomed ? '↙ 맞춤' : '🔍 확대'; };
  zoom.addEventListener('click', toggle);
  img.addEventListener('dblclick', toggle);
  let done = false;
  const shut = () => { if (done) return; done = true; wrap.remove(); document.body.classList.remove('cam-open'); window.removeEventListener('popstate', shut); };
  history.pushState(history.state, '');
  window.addEventListener('popstate', shut);
  const leave = () => { shut(); history.back(); };
  close.addEventListener('click', leave);
  edit.addEventListener('click', () => { leave(); contactOpen(c); });
}

function contactSetPhoto(url) {
  $('contactPhoto').src = url || '';
  show($('contactPhoto'), !!url);
  show($('contactPhotoEmpty'), !url);
  $('contactCamBtn').textContent = url ? '📷 다시 찍기' : '📷 명함 촬영';
}

function contactOpen(c) {
  contactState.editing = c || null;
  contactState.photo = null;
  contactState.clientId = c ? '' : crypto.randomUUID();
  $('contactTitle').textContent = c ? '명함 수정' : '명함 등록';
  $('contactSite').textContent = `현장: ${contactState.site}`;
  for (const [k, id] of Object.entries(CONTACT_FIELDS)) $(id).value = c?.[k] || '';
  $('contactMore').open = !!(c && Object.keys(CONTACT_FIELDS).some((k) => c[k]));
  $('contactError').textContent = '';
  $('contactNote').textContent = '';
  contactSetPhoto('');
  show($('contactDelete'), !!c);
  $('contactDialog').showModal();
  if (c?.photoId) contactPhotoUrl(c).then((url) => { if (contactState.editing === c && !contactState.photo) contactSetPhoto(url); }).catch(() => {});
}

// 사진 → 스캔 화면. 모달 창이 스캔 화면을 가리므로 그동안 닫았다가(적은 칸은 그대로) 다시 연다
async function contactScan(file) {
  if (!file) return;
  $('contactDialog').close();
  let res = null;
  try {
    res = await cardScan(file);
  } catch (err) {
    $('contactError').textContent = friendlyError(err, '사진을 열지 못했습니다. 다른 사진으로 해 보세요.');
  }
  $('contactDialog').showModal();
  if (!res) return;
  contactState.photo = { base64: res.base64 };
  contactSetPhoto(`data:image/jpeg;base64,${res.base64}`);
  $('contactNote').textContent = `보정한 명함 사진입니다(${Math.round(res.blob.size / 1024)}KB). 저장을 누르면 이 현장에 올라갑니다.`;
  $('contactError').textContent = '';
}

async function contactPicked(input) {
  const file = input.files[0];
  input.value = '';
  contactScan(file);
}

async function contactSave(e) {
  e.preventDefault();
  const base = contactState.editing ? { ...contactState.editing } : {};   // 화면에 없는 칸(전화·팩스·주소 등)은 그대로 둔다
  delete base.photoId; delete base.user; delete base.at;
  const contact = { ...base, site: contactState.site };
  for (const [k, id] of Object.entries(CONTACT_FIELDS)) contact[k] = $(id).value.trim();
  const hasPhoto = !!contactState.photo || !!contactState.editing?.photoId;
  if (!hasPhoto && !contact.name) { $('contactError').textContent = '명함을 찍거나, 이름을 적어 주세요.'; return; }
  if (contactState.editing) contact.id = contactState.editing.id;
  else { delete contact.id; contact.clientId = contactState.clientId; }
  const user = $('user').value || state.config.names?.[0] || '미지정';
  try {
    const res = await withBusy($('contactForm'), () => api('contact_save', { user, contact, ...(contactState.photo ? { photo: contactState.photo } : {}) }));
    if (contactState.photo && res.item.photoId) {
      const url = `data:image/jpeg;base64,${contactState.photo.base64}`;
      contactImgs.set(`${res.item.id}:${res.item.photoId}`, url);
      store.set(contactImgKey(res.item), url);
    }
    const i = contactState.items.findIndex((x) => x.id === res.item.id);
    contactState.items = i >= 0 ? contactState.items.map((x, j) => (j === i ? res.item : x)) : [...contactState.items, res.item];
    store.set(contactCacheKey(contactState.site), JSON.stringify(contactState.items));
    contactsRender('');
    $('contactDialog').close();
    flash('명함을 저장했습니다');
  } catch (err) {
    if (err.isAuth) { signOut(); return; }
    $('contactError').textContent = `저장하지 못했습니다. ${errorText(err)}`;
  }
}

async function contactRemove() {
  const c = contactState.editing;
  if (!c || !confirm(`${contactCaption(c) || '이'} 명함을 지울까요?`)) return;
  try {
    await withBusy($('contactForm'), () => api('contact_delete', { id: c.id }));
    contactState.items = contactState.items.filter((x) => x.id !== c.id);
    store.set(contactCacheKey(contactState.site), JSON.stringify(contactState.items));
    store.remove(contactImgKey(c));
    contactsRender('');
    $('contactDialog').close();
    flash('명함을 지웠습니다');
  } catch (err) {
    if (err.isAuth) { signOut(); return; }
    $('contactError').textContent = `지우지 못했습니다. ${errorText(err)}`;
  }
}

// 📷 명함 촬영: 앱 안 카메라(camera.js)로 한 장 찍으면 바로 닫는다. 못 열면 기본 카메라 — 앱(APK) 기본 카메라는 연속 촬영이라 한 장 찍고 뒤로가기
let contactCamOpen = false;
$('contactCamBtn').addEventListener('click', async () => {
  const native = () => {
    if (window.AndroidGallery) $('contactNote').textContent = '명함을 한 장 찍은 뒤 휴대폰 뒤로가기를 누르세요.';
    $('contactCam').click();
  };
  if (typeof openInAppCamera !== 'function' || typeof camSupported !== 'function' || !camSupported() || (typeof nativeCamOnly !== 'undefined' && nativeCamOnly)) { native(); return; }
  if (contactCamOpen) return;
  contactCamOpen = true;
  let shot = null;
  $('contactDialog').close();   // 모달 창이 카메라 화면을 가리지 않게
  try {
    await openInAppCamera({ room: 1, onShot: (file) => { shot = file; document.querySelector('.cam-view .cam-done')?.click(); } });
  } catch (err) {
    console.warn('앱 안 카메라를 못 열어 기본 카메라로 엽니다', err);
    $('contactDialog').showModal();
    native();
    return;
  } finally {
    contactCamOpen = false;
  }
  if (shot) contactScan(shot);
  else $('contactDialog').showModal();
});
$('contactAdd').addEventListener('click', () => contactOpen(null));
$('contactPickBtn').addEventListener('click', () => $('contactPick').click());
$('contactCam').addEventListener('change', () => contactPicked($('contactCam')));
$('contactPick').addEventListener('change', () => contactPicked($('contactPick')));
$('contactForm').addEventListener('submit', contactSave);
$('contactCancel').addEventListener('click', () => $('contactDialog').close());
$('contactDelete').addEventListener('click', contactRemove);
if (typeof drawingState !== 'undefined' && drawingState?.site && !$('drawingFilesView').classList.contains('hidden')) contactsOpenSite(drawingState.site);
