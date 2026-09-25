import {
  Rat, makeLamp, makeLampRow, makeCase,
} from './lib/light.js';
import { runReview } from './lib/review.js';
import { loadDraft, saveDraft, loadReview, saveReview, clearReview } from './lib/storage.js';

const state = {
  draft: loadDraft(),
  review: null, // 仅当与当前草稿指纹一致时才存在
  reviewAt: null,
  errors: [],
  touched: false, // 本次打开后是否已改动草稿（用于提示旧结论失效）
};

const saved = loadReview(state.draft);
if (saved) { state.review = saved.review; state.reviewAt = saved.at; }

const $cases = document.getElementById('cases');
const $verdict = document.getElementById('verdict');
const $errors = document.getElementById('errors');
const $saveState = document.getElementById('save-state');
const $btnReview = document.getElementById('btn-review');
const $btnAddCase = document.getElementById('btn-add-case');

const fmt = (r) => (r instanceof Rat ? r.toString() : String(r));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------------- 渲染 ---------------- */

function errKey(ci, li, ri, field) {
  return `${ci}|${li ?? ''}|${ri ?? ''}|${field ?? ''}`;
}
function errMap() {
  const m = new Map();
  for (const e of state.errors) m.set(errKey(e.caseIdx, e.lampIdx, e.rowIdx, e.field), e.msg);
  return m;
}

function render() {
  const emap = errMap();
  const errAt = (ci, li, ri, field) => emap.get(errKey(ci, li, ri, field));

  $cases.innerHTML = state.draft.cases.map((cs, ci) => {
    const caseErr = (field) => errAt(ci, null, null, field);
    const fieldCls = (msg) => (msg ? 'invalid' : '');
    const fieldTitle = (msg) => (msg ? ` title="${esc(msg)}"` : '');
    const cell = (field, label, value, placeholder = '') => `
      <label class="fld ${fieldCls(caseErr(field))}" ${fieldTitle(caseErr(field))}>
        <span>${label}</span>
        <input type="text" inputmode="decimal" data-ci="${ci}" data-field="${field}"
               value="${esc(value)}" placeholder="${placeholder}" />
      </label>`;

    const lamps = cs.lamps.map((lp, li) => {
      const noErr = errAt(ci, li, null, 'no');
      const rows = lp.rows.map((r, ri) => {
        const eOn = errAt(ci, li, ri, 'on');
        const eOff = errAt(ci, li, ri, 'off');
        const eIuv = errAt(ci, li, ri, 'iuv');
        return `
        <div class="row">
          <input type="text" inputmode="decimal" class="${eOn ? 'invalid' : ''}" title="${esc(eOn || '')}"
                 data-ci="${ci}" data-li="${li}" data-ri="${ri}" data-field="on" value="${esc(r.on)}" placeholder="启动" />
          <span class="sep">→</span>
          <input type="text" inputmode="decimal" class="${eOff ? 'invalid' : ''}" title="${esc(eOff || '')}"
                 data-ci="${ci}" data-li="${li}" data-ri="${ri}" data-field="off" value="${esc(r.off)}" placeholder="停止" />
          <input type="text" inputmode="decimal" class="iuv ${eIuv ? 'invalid' : ''}" title="${esc(eIuv || '')}"
                 data-ci="${ci}" data-li="${li}" data-ri="${ri}" data-field="iuv" value="${esc(r.iuv)}" placeholder="照度" />
          <button type="button" class="btn-mini" data-act="del-row" data-ci="${ci}" data-li="${li}" data-ri="${ri}"
                  ${lp.rows.length <= 1 ? 'disabled' : ''}>删段</button>
        </div>`;
      }).join('');

      return `
      <div class="lamp">
        <div class="lamp-head">
          <label class="fld lamp-no ${noErr ? 'invalid' : ''}" ${fieldTitle(noErr)}>
            <span>灯号</span>
            <input type="text" data-ci="${ci}" data-li="${li}" data-field="no" value="${esc(lp.no)}" />
          </label>
          <button type="button" class="btn-mini" data-act="del-lamp" data-ci="${ci}" data-li="${li}"
                  ${cs.lamps.length <= 3 ? 'disabled title="每柜至少 3 盏灯"' : ''}>删灯</button>
          <button type="button" class="btn-mini" data-act="add-row" data-ci="${ci}" data-li="${li}">＋ 启停区间</button>
        </div>
        <div class="rows">
          <div class="row row-head"><span>启动 h</span><span></span><span>停止 h</span><span>紫外照度 μW/cm²</span><span></span></div>
          ${rows}
        </div>
      </div>`;
    }).join('');

    const caseCountErr = errAt(ci, null, null, 'lamps');
    return `
    <article class="case" data-ci="${ci}">
      <header class="case-head">
        <label class="fld case-name"><span>展柜名称</span>
          <input type="text" data-ci="${ci}" data-field="name" value="${esc(cs.name)}" /></label>
        <button type="button" class="btn-mini danger" data-act="del-case" data-ci="${ci}"
                ${state.draft.cases.length <= 2 ? 'disabled title="至少保留 2 个展柜"' : ''}>删除展柜</button>
      </header>
      <div class="case-fields">
        ${cell('winLen', '滑动窗口长度 L (h)', cs.winLen, '如 2')}
        ${cell('winLimit', '最大窗口剂量限额', cs.winLimit, 'μW·h/cm²')}
        ${cell('totalLimit', '累计剂量上限', cs.totalLimit, 'μW·h/cm²')}
      </div>
      ${caseCountErr ? `<p class="err-text">${esc(caseCountErr)}</p>` : ''}
      <div class="lamps">${lamps}</div>
      <button type="button" class="btn-mini" data-act="add-lamp" data-ci="${ci}"
              ${cs.lamps.length >= 8 ? 'disabled' : ''}>＋ 添加灯（${cs.lamps.length}/8，需 3–8 盏）</button>
      ${renderReport(ci)}
    </article>`;
  }).join('');

  $btnAddCase.disabled = state.draft.cases.length >= 6;
  renderErrors();
  renderVerdict();
}

function eventsText(p) {
  const parts = [];
  if (p.onLamps?.length) parts.push(`开启：${p.onLamps.join('、')}`);
  if (p.offLamps?.length) parts.push(`熄灭：${p.offLamps.join('、')}`);
  return parts.join('；');
}

function piecesTable(pieces, { fromZero = false } = {}) {
  if (!pieces.length) return '<p class="muted">该时段内无灯光。</p>';
  return `
  <table class="pieces">
    <thead><tr><th>起 t (h)</th><th>止 (h)</th><th>时长 (h)</th><th>紫外照度 (μW/cm²)</th><th>照度变化（灯号联动）</th></tr></thead>
    <tbody>
      ${pieces.map((p) => `
        <tr${p.iuv.isZero() ? ' class="zero"' : ''}>
          <td>${fmt(p.t)}</td>
          <td>${fmt(p.end)}</td>
          <td>${fmt(p.end.sub(p.t))}</td>
          <td>${fmt(p.iuv)}</td>
          <td>${esc(eventsText(p) || (fromZero ? '照度不变' : '—'))}</td>
        </tr>`).join('')}
    </tbody>
  </table>`;
}

function renderReport(ci) {
  const r = state.review?.reports?.[ci];
  if (!r) return '';
  const tBadge = (bad) => bad ? 'badge bad' : 'badge good';
  const tWord = (bad) => bad ? '超限' : '合规';
  return `
  <div class="report">
    <h4>复核结果 · ${esc(r.name)}</h4>

    <div class="rep-block">
      <div class="rep-title">完整时段累计剂量
        <span class="${tBadge(r.total.exceeded)}">${tWord(r.total.exceeded)}</span>
      </div>
      <p class="kv">展期点亮时段：${r.scheduleStart ? `<b>${fmt(r.scheduleStart)}</b> h 至 <b>${fmt(r.scheduleEnd)}</b> h` : '<b class="muted">无任何点亮区间</b>'}</p>
      <p class="kv">累计剂量：<b class="${r.total.exceeded ? 'num-bad' : 'num-good'}">${fmt(r.total.dose)}</b>
        / 上限 ${fmt(r.total.limit)} μW·h/cm²</p>
      <details open><summary>完整时段照度分段（所有灯左闭右开叠加，共 ${r.schedulePieces.length} 段）</summary>
        ${piecesTable(r.schedulePieces, { fromZero: true })}
      </details>
    </div>

    <div class="rep-block">
      <div class="rep-title">长度 ${fmt(r.window.length)} h 的滑动窗口最大剂量
        <span class="${tBadge(r.window.exceeded)}">${tWord(r.window.exceeded)}</span>
      </div>
      ${r.window.start ? `
      <p class="kv">最大窗口精确起止：<b>[${fmt(r.window.start)}, ${fmt(r.window.end)})</b> h</p>
      <p class="kv">窗口积分剂量：<b class="${r.window.exceeded ? 'num-bad' : 'num-good'}">${fmt(r.window.maxDose)}</b>
        / 限额 ${fmt(r.window.limit)} μW·h/cm²</p>
      ${r.window.note ? `<p class="muted">${esc(r.window.note)}</p>` : ''}
      ${r.window.exceeded && r.window.crossing ? `
        <p class="kv crossing">最早违规窗口精确起点：<b>${fmt(r.window.crossing.crossing)}</b> h
          （窗口起点${r.window.crossing.strictlyAfter ? '严格晚于' : '为'}该时刻时，窗口剂量超过限额 ${fmt(r.window.limit)}）</p>` : ''}
      <details open><summary>最大窗口内照度变化（共 ${r.window.pieces.length} 段）</summary>
        ${piecesTable(r.window.pieces)}
      </details>` : '<p class="muted">所有灯在本柜均无有效启停区间，任意窗口剂量均为 0。</p>'}
    </div>
  </div>`;
}

function renderVerdict() {
  if (!state.review) {
    $verdict.innerHTML = state.touched
      ? '<div class="banner stale">草稿已修改：此前的复核结论已失效，已不在页面显示；请重新「发起复核」。</div>'
      : '';
    return;
  }
  const at = state.reviewAt ? new Date(state.reviewAt).toLocaleString() : '';
  if (state.review.passed) {
    $verdict.innerHTML = `
      <div class="banner pass">
        <b>复核通过</b>：全部 ${state.review.reports.length} 个展柜的累计剂量与所有长度为指定值的连续滑动窗口剂量均未超限。
        <span class="at">最近有效复核：${at}</span>
      </div>`;
  } else {
    const e = state.review.firstEvidence;
    const isTotal = e.kind === 'total';
    $verdict.innerHTML = `
      <div class="banner fail">
        <b>复核不通过</b>：共发现 ${state.review.violations.length} 项超限。
        <span class="at">最近有效复核：${at}</span>
      </div>
      <div class="evidence">
        <h4>首项证据（稳定确定）</h4>
        <p>按<b>展柜输入顺序</b>优先、同柜内再按<b>违规窗口起点时刻</b>升序确定：</p>
        <ul>
          <li>展柜：第 ${e.caseIdx + 1} 柜「${esc(e.caseName)}」</li>
          <li>违规类型：${isTotal ? '完整时段累计剂量超限' : '滑动窗口剂量超限'}</li>
          ${isTotal
            ? `<li>完整时段 [${fmt(e.windowStart)}, ${fmt(e.windowEnd)}) h 累计剂量 <b class="num-bad">${fmt(e.dose)}</b> > 上限 ${fmt(e.limit)}</li>`
            : `<li>窗口长度 ${fmt(e.length)} h；最早违规窗口起点 <b class="num-bad">${fmt(e.windowStart)}</b> h
                 （该时刻${e.strictlyAfter ? '之后' : '起'}窗口剂量 > ${fmt(e.limit)}）</li>
               <li>同柜最大剂量窗口 [${fmt(e.maxWindow.start)}, ${fmt(e.maxWindow.end)}) h，剂量 ${fmt(e.maxWindow.dose)}</li>`}
        </ul>
      </div>`;
  }
}

function renderErrors() {
  if (!state.errors.length) { $errors.hidden = true; $errors.innerHTML = ''; return; }
  $errors.hidden = false;
  $errors.innerHTML = `
    <h3>无法发起复核：请一次性处理以下 ${state.errors.length} 项问题（左闭右开区间，停止须晚于启动）</h3>
    <ol>${state.errors.map((e) => `<li>${esc(e.msg)}</li>`).join('')}</ol>`;
}

/* ---------------- 交互 ---------------- */

function persist() {
  saveDraft(state.draft);
  $saveState.textContent = '草稿已保存于本机 · ' + new Date().toLocaleTimeString();
}

function markDirty() {
  if (state.review) {
    state.review = null;
    state.reviewAt = null;
    clearReview();
  }
  state.touched = true;
}

document.addEventListener('input', (ev) => {
  const el = ev.target;
  if (!(el instanceof HTMLInputElement) || !el.dataset.field) return;
  const ci = +el.dataset.ci;
  const li = el.dataset.li;
  const ri = el.dataset.ri;
  const { field } = el.dataset;
  const cs = state.draft.cases[ci];
  if (li === undefined) cs[field] = el.value;
  else if (ri === undefined) cs.lamps[+li][field] = el.value;
  else cs.lamps[+li].rows[+ri][field] = el.value;
  markDirty();
  persist();
  // 每次改动都重渲染：确保旧复核结论立即从页面消失、字段错误态即时刷新
  state.errors = [];
  const caret = el.selectionStart;
  render();
  refocus(el, caret);
});

function refocus(el, caret) {
  const q = el.dataset.ri !== undefined
    ? `[data-ci="${el.dataset.ci}"][data-li="${el.dataset.li}"][data-ri="${el.dataset.ri}"][data-field="${el.dataset.field}"]`
    : el.dataset.li !== undefined
      ? `[data-ci="${el.dataset.ci}"][data-li="${el.dataset.li}"][data-field="${el.dataset.field}"]`
      : `[data-ci="${el.dataset.ci}"][data-field="${el.dataset.field}"]`;
  const n = document.querySelector(q);
  if (n) {
    if (typeof n.focus === 'function') n.focus();
    const pos = Math.min(caret ?? n.value.length, n.value.length);
    if (typeof n.setSelectionRange === 'function') n.setSelectionRange(pos, pos);
  }
}

document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const { act } = btn.dataset;
  const ci = +btn.dataset.ci;
  const li = btn.dataset.li === undefined ? null : +btn.dataset.li;
  const ri = btn.dataset.ri === undefined ? null : +btn.dataset.ri;
  const cs = state.draft.cases[ci];

  switch (act) {
    case 'del-case':
      if (state.draft.cases.length <= 2) return;
      state.draft.cases.splice(ci, 1);
      break;
    case 'add-lamp':
      if (cs.lamps.length >= 8) return;
      cs.lamps.push(makeLamp(nextLampNo(cs)));
      break;
    case 'del-lamp':
      if (cs.lamps.length <= 3) return;
      cs.lamps.splice(li, 1);
      break;
    case 'add-row':
      cs.lamps[li].rows.push(makeLampRow());
      break;
    case 'del-row':
      if (cs.lamps[li].rows.length <= 1) return;
      cs.lamps[li].rows.splice(ri, 1);
      break;
    default:
      return;
  }
  markDirty();
  state.errors = [];
  persist();
  render();
});

function nextLampNo(cs) {
  const used = new Set(cs.lamps.map((l) => String(l.no).trim()).filter(Boolean));
  for (let k = cs.lamps.length + 1; ; k++) if (!used.has(String(k))) return k;
}

$btnAddCase.addEventListener('click', () => {
  if (state.draft.cases.length >= 6) return;
  state.draft.cases.push(makeCase(state.draft.cases.length + 1));
  markDirty();
  state.errors = [];
  persist();
  render();
});

$btnReview.addEventListener('click', () => {
  const res = runReview(state.draft);
  if (!res.ok) {
    state.errors = res.errors;
    state.review = null;
    state.reviewAt = null;
    clearReview();
    render();
    $errors.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  state.errors = [];
  state.review = res;
  state.reviewAt = res.at;
  state.touched = false;
  saveReview(state.draft, res);
  render();
  $verdict.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

render();
