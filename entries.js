// 입력 실수 대책: (1) 저장 전에 전회값과 너무 다르면 다시 묻기, (2) 최근 입력을 눌러 수정·삭제하기(입력 후 24시간 안, 본인 것만).
// 이 파일은 app.js보다 먼저 읽히므로, 화면 요소($)와 state는 함수가 불릴 때만 쓴다.

const UNUSUAL_RATIO = 5;
const EDIT_IDS = ['ev0', 'ev1', 'ev2'];

// ponytail: 전회값 대비 비율(5배 이상 또는 1/5 이하)만 본다. 종류별 기준은 관리기준값을 받은 뒤에 만든다
function unusualChange(values, lastValues, unit) {
  const lines = [];
  values.forEach((v, i) => {
    const prev = lastValues[i];
    if (!Number.isFinite(v) || !Number.isFinite(prev) || prev === 0) return;
    const ratio = Math.abs(v / prev);
    if (ratio >= UNUSUAL_RATIO || ratio <= 1 / UNUSUAL_RATIO) {
      lines.push(`${values.length > 1 ? `값 ${i + 1}: ` : ''}전회 ${prev} → 지금 ${v}${unit ? ` ${unit}` : ''}`);
    }
  });
  if (lines.length === 0) return '';
  return `${lines.join('\n')}\n\n전회와 차이가 매우 큽니다. 소수점이나 자릿수를 확인하세요.\n그대로 저장할까요?`;
}

// 저장 직전에 부른다. 문제가 있어 사용자가 취소하면 false
function confirmUnusual() {
  if (state.issue) return true;
  const inst = selectedInstrument();
  if (!inst || state.type === OTHER || state.type === SURVEY) return true;
  const last = state.latest[inst.id];
  if (!last) return true;
  const form = readForm();
  const values = form.values ?? [form.value];
  const text = unusualChange(values, last.values?.length ? last.values : [last.value], inst.unit);
  return !text || confirm(text);
}

let editing = null;

function openEdit(row) {
  if (!row.canEdit) {
    alert('입력한 지 24시간이 지나 앱에서는 고칠 수 없습니다.\n관리자에게 문의해 주세요.');
    return;
  }
  editing = row;
  const isIssue = !!row.issue;
  const count = Math.max(row.values?.length ?? 1, 1);
  $('editInfo').textContent = `${row.id} · ${row.type}${isIssue ? ` · ⚠ ${row.issue}` : ''}`;
  EDIT_IDS.forEach((id, i) => {
    show($(id).parentElement, !isIssue && i < count);
    $(id).value = row.values?.[i] ?? '';
  });
  $('editDate').value = row.date;
  $('editMemo').value = row.memo ?? '';
  $('editError').textContent = '';
  $('editDialog').showModal();
}

// 홈에서 고쳐도 보이도록 맨 위 안내 줄(flash)로 알리고 최근 목록·전회값을 새로 읽는다
async function finishEdit(message) {
  $('editDialog').close();
  editing = null;
  flash(`✓ ${message}`);
  await reloadLists();
}

// 수정·삭제 요청 한 번: 진행 중에는 창의 버튼이 모두 잠긴다. 24시간·본인 확인은 서버가 최종 판단한다
async function requestEdit(action, payload, doneMessage) {
  await withBusy($('editForm'), async () => {
    try {
      await api(action, { user: $('user').value, ...payload });
    } catch (err) {
      if (err.isAuth) { signOut(); return; }
      $('editError').textContent = errorText(err);
      return;
    }
    await finishEdit(doneMessage);
  });
}

async function saveEdit(e) {
  e.preventDefault();
  if (!editing || $('editForm').getAttribute('aria-busy')) return;
  const isIssue = !!editing.issue;
  const count = Math.max(editing.values?.length ?? 1, 1);
  const values = isIssue ? [] : EDIT_IDS.slice(0, count).map((id) => ($(id).value.trim() === '' ? null : Number($(id).value)));
  if (values.some((v) => v === null || !Number.isFinite(v))) { $('editError').textContent = '값을 모두 숫자로 넣어 주세요.'; return; }
  $('editError').textContent = '';
  await requestEdit('edit', { entry: { clientId: editing.clientId, values, issue: editing.issue || '', date: $('editDate').value, memo: $('editMemo').value.trim() } }, '수정됨');
}

async function removeEntry() {
  if (!editing || $('editForm').getAttribute('aria-busy')) return;
  if (!confirm(`${editing.id} (${editing.date}) 기록을 삭제할까요?\n시트에는 '삭제' 표시로 남고, 전회값·최근 목록·그래프에서는 빠집니다.`)) return;
  $('editError').textContent = '';
  await requestEdit('delete', { clientId: editing.clientId }, '삭제됨');
}

if (typeof module !== 'undefined') module.exports = { unusualChange };
