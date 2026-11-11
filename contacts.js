// 현장 담당자 명함(2026-11-11): 도면 탭에서 현장 폴더를 열면 위에 그 현장 담당자 카드가 보인다.
// 리멤버처럼: 명함 촬영 → 글자 읽기(ocr-kit.js) → 항목 나누기(card-parse.js) → 사람이 확인·고침 → 저장(Code.gs contact_save, 시트 '명함' + Drive 명함/<현장>/)
// app.js·drawing.js 다음에 읽힌다: $, api, state, store, flash, errorText, compressPhoto, signOut 를 쓴다.

const CONTACT_FIELDS = { name: 'cfName', title: 'cfTitle', company: 'cfCompany', dept: 'cfDept', mobile: 'cfMobile', phone: 'cfPhone', fax: 'cfFax', email: 'cfEmail', address: 'cfAddress', memo: 'cfMemo' };
const CARD_OCR_WIDTH = 1600;   // 명함은 작아서 이 폭이면 충분하다(계획서 2200 보다 빠르다)

const contactState = { site: '', items: [], seq: 0, editing: null, photo: null, clientId: '' };
const contactCacheKey = (site) => `contacts_${site}`;

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
    contactsRender(err.code === 'bad_action' ? '서버가 아직 옛 버전입니다(관리자: Code.gs 새 버전 배포).' : (cached ? '' : `담당자를 불러오지 못했습니다. ${errorText(err)}`));
  }
}
window.contactsOpenSite = contactsOpenSite;

function contactLink(href, icon, text, cls) {
  const a = document.createElement('a');
  a.className = `cc-act ${cls}`;
  a.href = href;
  const i = document.createElement('span');
  i.className = 'cc-ic';
  i.setAttribute('aria-hidden', 'true');
  i.textContent = icon;
  const t = document.createElement('span');
  t.textContent = text;
  a.append(i, t);
  a.addEventListener('click', (e) => e.stopPropagation());   // 전화·메일 누르면 카드 수정 창은 안 뜬다
  return a;
}

function contactsRender(note) {
  const box = $('contactCards');
  if (!contactState.items.length) {
    const p = document.createElement('p');
    p.className = 'contacts-empty';
    p.textContent = note || '아직 담당자 명함이 없습니다. 현장 소장님 명함을 받으면 「＋ 명함 등록」으로 찍어 두세요.';
    box.replaceChildren(p);
    return;
  }
  box.replaceChildren(...contactState.items.map((c) => {
    const card = document.createElement('article');
    card.className = 'contact-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `${c.name} ${c.title} 명함 — 눌러서 수정`);
    const top = document.createElement('div');
    top.className = 'cc-top';
    const av = document.createElement('span');
    av.className = 'cc-avatar';
    av.setAttribute('aria-hidden', 'true');
    av.textContent = c.name.slice(0, 1);
    const who = document.createElement('div');
    who.className = 'cc-who';
    const line1 = document.createElement('p');
    line1.className = 'cc-name';
    const role = document.createElement('span');
    role.className = 'cc-role';
    role.textContent = '담당자';
    const nm = document.createElement('b');
    nm.textContent = c.name;
    line1.append(role, nm);
    if (c.title) { const t = document.createElement('span'); t.className = 'cc-title'; t.textContent = c.title; line1.append(t); }
    const line2 = document.createElement('p');
    line2.className = 'cc-company';
    line2.textContent = [c.company, c.dept].filter(Boolean).join(' · ') || '회사 미입력';
    who.append(line1, line2);
    top.append(av, who);
    const acts = document.createElement('div');
    acts.className = 'cc-acts';
    if (c.mobile) acts.append(contactLink(`tel:${c.mobile.replace(/[^\d+]/g, '')}`, '📱', c.mobile, 'mobile'));
    if (c.phone) acts.append(contactLink(`tel:${c.phone.replace(/[^\d+]/g, '')}`, '☎', c.phone, 'phone'));
    if (c.email) acts.append(contactLink(`mailto:${c.email}`, '✉', c.email, 'email'));
    card.append(top, acts);
    const extra = [c.fax ? `팩스 ${c.fax}` : '', c.address, c.memo].filter(Boolean);
    if (extra.length) {
      const ex = document.createElement('p');
      ex.className = 'cc-extra';
      ex.textContent = extra.join(' · ');
      card.append(ex);
    }
    const open = () => contactOpen(c);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    return card;
  }));
}

function contactFill(c) {
  for (const [k, id] of Object.entries(CONTACT_FIELDS)) $(id).value = c?.[k] || '';
}

function contactOpen(c) {
  contactState.editing = c || null;
  contactState.photo = null;
  contactState.clientId = c ? '' : crypto.randomUUID();
  $('contactTitle').textContent = c ? '명함 수정' : '명함 등록';
  $('contactSite').textContent = `현장: ${contactState.site}`;
  contactFill(c);
  $('contactError').textContent = '';
  $('contactOcrNote').textContent = c ? '사진을 다시 찍으면 읽은 값으로 빈 칸만 채웁니다.' : '명함을 화면 가득, 반듯하게 찍으면 이름·전화·이메일을 자동으로 채웁니다.';
  show($('contactPhoto'), false);
  $('contactPhoto').removeAttribute('src');
  show($('contactDelete'), !!c);
  $('contactDialog').showModal();
  if (c?.photoId) contactShowSavedPhoto(c);
}

async function contactShowSavedPhoto(c) {
  try {
    const { base64 } = await api('contact_photo', { id: c.id });
    if (contactState.editing !== c || contactState.photo) return;
    $('contactPhoto').src = `data:image/jpeg;base64,${base64}`;
    show($('contactPhoto'), true);
  } catch { /* 사진은 덤: 못 받아도 수정은 된다 */ }
}

async function contactPicked(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  $('contactError').textContent = '';
  const note = $('contactOcrNote');
  try {
    const photo = await compressPhoto(file);   // 150KB JPEG(서버·사진 보관용)
    contactState.photo = photo;
    $('contactPhoto').src = `data:image/jpeg;base64,${photo.base64}`;
    show($('contactPhoto'), true);
    note.textContent = '명함 글자를 읽는 중... (처음 한 번은 글자 읽기 기능을 받느라 조금 걸립니다)';
    window.busyText = window.busyText || (() => {});
    const got = CardParse.parseCard(await ocrLinesRefined(await ocrImageCanvas(file, CARD_OCR_WIDTH), '명함'));
    const editing = !!contactState.editing;
    let filled = 0;
    for (const [k, id] of Object.entries(CONTACT_FIELDS)) {
      if (!got[k] || (editing && $(id).value.trim())) continue;   // 수정 중이면 사람이 적어 둔 칸은 덮지 않는다
      $(id).value = got[k];
      filled += 1;
    }
    note.textContent = filled ? `${filled}칸을 채웠습니다. 틀린 글자가 있으면 고친 뒤 저장하세요.` : '글자를 거의 못 읽었습니다. 밝은 곳에서 명함만 화면 가득 다시 찍거나 직접 입력하세요.';
    if (!$('cfName').value) $('cfName').focus();
  } catch (err) {
    note.textContent = friendlyError(err, '명함을 읽지 못했습니다. 직접 입력해 주세요.');
  }
}

async function contactSave(e) {
  e.preventDefault();
  const contact = { site: contactState.site };
  for (const [k, id] of Object.entries(CONTACT_FIELDS)) contact[k] = $(id).value.trim();
  if (!contact.name) { $('contactError').textContent = '담당자 이름을 적어 주세요.'; $('cfName').focus(); return; }
  if (contactState.editing) contact.id = contactState.editing.id;
  else contact.clientId = contactState.clientId;
  const user = $('user').value || state.config.names?.[0] || '미지정';
  try {
    const res = await withBusy($('contactForm'), () => api('contact_save', { user, contact, ...(contactState.photo ? { photo: contactState.photo } : {}) }));
    const i = contactState.items.findIndex((x) => x.id === res.item.id);
    contactState.items = i >= 0 ? contactState.items.map((x, j) => (j === i ? res.item : x)) : [...contactState.items, res.item];
    store.set(contactCacheKey(contactState.site), JSON.stringify(contactState.items));
    contactsRender('');
    $('contactDialog').close();
    flash(`${res.item.name} 명함을 저장했습니다`);
  } catch (err) {
    if (err.isAuth) { signOut(); return; }
    $('contactError').textContent = `저장하지 못했습니다. ${errorText(err)}`;
  }
}

async function contactRemove() {
  const c = contactState.editing;
  if (!c || !confirm(`${c.name} 명함을 지울까요?`)) return;
  try {
    await withBusy($('contactForm'), () => api('contact_delete', { id: c.id }));
    contactState.items = contactState.items.filter((x) => x.id !== c.id);
    store.set(contactCacheKey(contactState.site), JSON.stringify(contactState.items));
    contactsRender('');
    $('contactDialog').close();
    flash('명함을 지웠습니다');
  } catch (err) {
    if (err.isAuth) { signOut(); return; }
    $('contactError').textContent = `지우지 못했습니다. ${errorText(err)}`;
  }
}

$('contactAdd').addEventListener('click', () => contactOpen(null));
// 📷 명함 촬영: 앱 안 카메라(camera.js)로 한 장 찍으면 바로 닫는다. 못 열면 기본 카메라 — 앱(APK) 기본 카메라는 연속 촬영이라 한 장 찍고 뒤로가기
let contactCamOpen = false;
$('contactCamBtn').addEventListener('click', async () => {
  const native = () => {
    if (window.AndroidGallery) $('contactOcrNote').textContent = '명함을 한 장 찍은 뒤 휴대폰 뒤로가기를 누르세요.';
    $('contactCam').click();
  };
  if (typeof openInAppCamera !== 'function' || typeof camSupported !== 'function' || !camSupported() || (typeof nativeCamOnly !== 'undefined' && nativeCamOnly)) { native(); return; }
  if (contactCamOpen) return;
  contactCamOpen = true;
  let shot = null;
  // 열린 <dialog> 는 화면 맨 위 층이라 카메라 화면이 그 뒤에 가려진다 → 찍는 동안 창을 잠시 닫았다가(적은 칸은 그대로) 다시 연다
  $('contactDialog').close();
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
  $('contactDialog').showModal();
  if (shot) contactPicked({ files: [shot], set value(v) { /* 파일 칸이 아니라 지울 것 없음 */ } });
});
$('contactPickBtn').addEventListener('click', () => $('contactPick').click());
$('contactCam').addEventListener('change', () => contactPicked($('contactCam')));
$('contactPick').addEventListener('change', () => contactPicked($('contactPick')));
$('contactForm').addEventListener('submit', contactSave);
$('contactCancel').addEventListener('click', () => $('contactDialog').close());
$('contactDelete').addEventListener('click', contactRemove);
if (drawingState?.site && !$('drawingFilesView').classList.contains('hidden')) contactsOpenSite(drawingState.site);
