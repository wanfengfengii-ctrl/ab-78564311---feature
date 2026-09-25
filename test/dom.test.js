import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 每个用例都需要干净的模块/DOM 环境，统一通过 freshEnv() 构造
async function freshEnv() {
  const html = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'index.html'), 'utf8');
  const { window, document } = parseHTML(html);
  const store = new Map();
  globalThis.window = window;
  globalThis.document = document;
  globalThis.HTMLInputElement = window.HTMLInputElement;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  window.HTMLElement.prototype.scrollIntoView = () => {};
  // main.js 在导入时即完成首次渲染
  await import('../src/main.js?t=' + Math.random());
  return { window, document, store };
}

function setValue(document, sel, v) {
  // 每次输入都会整体重渲染，节点可能被替换：设置前现查
  const el = document.querySelector(sel);
  el.value = v;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}

function fillValidDraft(document) {
  // 默认 2 柜 × 3 灯 × 1 行；逐字段现查现设
  document.querySelectorAll('article.case').forEach((art) => {
    const ci = art.dataset.ci;
    setValue(document, `[data-ci="${ci}"][data-field="winLen"]`, '2');
    setValue(document, `[data-ci="${ci}"][data-field="winLimit"]`, '9');
    setValue(document, `[data-ci="${ci}"][data-field="totalLimit"]`, '100');
    for (let li = 0; li < 3; li++) {
      setValue(document, `[data-ci="${ci}"][data-li="${li}"][data-ri="0"][data-field="on"]`, '0');
      setValue(document, `[data-ci="${ci}"][data-li="${li}"][data-ri="0"][data-field="off"]`, '2');
      setValue(document, `[data-ci="${ci}"][data-li="${li}"][data-ri="0"][data-field="iuv"]`, '1');
    }
  });
}

before(() => { /* 环境在每个用例内单独建立 */ });

test('DOM：初始渲染 2 柜 × 3 灯，可有效复核并按柜展示报告', async () => {
  const { document } = await freshEnv();
  assert.equal(document.querySelectorAll('article.case').length, 2);
  assert.equal(document.querySelectorAll('article.case')[0].querySelectorAll('.lamp').length, 3);
  assert.equal(document.querySelector('#verdict').innerHTML, '');

  fillValidDraft(document);
  document.getElementById('btn-review').dispatchEvent(new window.Event('click', { bubbles: true }));

  assert.match(document.querySelector('#verdict').textContent, /复核通过/);
  const reports = document.querySelectorAll('.report');
  assert.equal(reports.length, 2);
  // 每柜：累计剂量 6（3 灯 × 1 × 2h）、最大窗口 [0,2) 剂量 6
  assert.match(reports[0].textContent, /累计剂量[\s\S]*6[\s\S]*上限 100/);
  assert.match(reports[0].textContent, /\[0, 2\)/);
  // 完整时段照度分段表：合计照度 3，单段 [0,2)
  const rows = reports[0].querySelectorAll('table.pieces tbody tr');
  assert.ok(rows.length >= 1);
});

test('DOM：超限时给出按柜顺序与窗口起点稳定确定的首项证据', async () => {
  const { document } = await freshEnv();
  fillValidDraft(document);
  // 第 1 柜限额收紧到 3.5：i=3 恒定，任何 2h 窗口剂量都是 6 → 起点 0 即超限
  const el = document.querySelector('[data-ci="0"][data-field="winLimit"]');
  el.value = '3.5';
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  document.getElementById('btn-review').dispatchEvent(new window.Event('click', { bubbles: true }));

  assert.match(document.querySelector('#verdict').textContent, /复核不通过/);
  const ev = document.querySelector('.evidence');
  assert.match(ev.textContent, /第 1 柜/);
  assert.match(ev.textContent, /滑动窗口剂量超限/);
  assert.match(ev.textContent, /最早违规窗口起点[\s\S]*0(\s|h)/);
});

test('DOM：草稿改动后旧结论立即消失并提示失效；重新复核恢复', async () => {
  const { document } = await freshEnv();
  fillValidDraft(document);
  document.getElementById('btn-review').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.match(document.querySelector('#verdict').textContent, /复核通过/);

  // 改动任一字段
  const el = document.querySelector('[data-ci="1"][data-field="iuv"]');
  el.value = '1.2';
  el.dispatchEvent(new window.Event('input', { bubbles: true }));

  assert.match(document.querySelector('#verdict').textContent, /旧的复核结论已失效|复核结论已失效/);
  assert.equal(document.querySelectorAll('.report').length, 0);

  // 重新复核：第 2 柜窗口剂量 6.4 仍 < 9，累计 6.4 < 100 → 通过
  document.getElementById('btn-review').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.match(document.querySelector('#verdict').textContent, /复核通过/);
  assert.equal(document.querySelectorAll('.report').length, 2);
});

test('DOM：非法区间、重复灯号、不合理限额一次列出并阻止复核', async () => {
  const { document } = await freshEnv();

  // 第 1 柜：窗口长度 0、窗口限额 > 累计上限
  setValue(document, '[data-ci="0"][data-field="winLen"]', '0');
  setValue(document, '[data-ci="0"][data-field="winLimit"]', '50');
  setValue(document, '[data-ci="0"][data-field="totalLimit"]', '3');
  // 第 1 柜第 1 行停止早于启动
  setValue(document, '[data-ci="0"][data-li="0"][data-ri="0"][data-field="on"]', '2');
  setValue(document, '[data-ci="0"][data-li="0"][data-ri="0"][data-field="off"]', '1');
  setValue(document, '[data-ci="0"][data-li="0"][data-ri="0"][data-field="iuv"]', '1');
  // 灯号重复：第 2 盏改成与第 1 盏同号
  setValue(document, '[data-ci="0"][data-li="1"][data-field="no"]', '1');
  // 照度非法（第 3 盏）
  setValue(document, '[data-ci="0"][data-li="2"][data-ri="0"][data-field="iuv"]', 'x');

  document.getElementById('btn-review').dispatchEvent(new window.Event('click', { bubbles: true }));

  const box = document.getElementById('errors');
  assert.equal(box.hidden, false);
  const text = box.textContent;
  assert.match(text, /窗口长度必须大于 0/);
  assert.match(text, /大于累计上限/);
  assert.match(text, /必须晚于启动时刻/);
  assert.match(text, /灯号“1”重复/);
  assert.match(text, /紫外线照度缺失或非法/);
  // 阻止复核：无结论横幅、无报告（仅有失效/错误提示）
  assert.equal(document.querySelectorAll('.report').length, 0);
  assert.doesNotMatch(document.querySelector('#verdict').textContent, /复核通过|复核不通过/);
  assert.doesNotMatch(document.querySelector('#verdict').textContent, /首项证据/);
});

test('DOM：添加/删除展柜与灯的数量边界（2–6 柜、3–8 灯）', async () => {
  const { document } = await freshEnv();
  // 初始 2 柜：删柜按钮禁用（下限）
  assert.equal(document.querySelector('[data-act="del-case"]').disabled, true);
  // 添加展柜到上限 6（每次重渲染，按钮需现查）
  for (let k = 0; k < 4; k++) {
    document.getElementById('btn-add-case').dispatchEvent(new window.Event('click', { bubbles: true }));
  }
  assert.equal(document.querySelectorAll('article.case').length, 6);
  assert.equal(document.getElementById('btn-add-case').disabled, true);
  // 6 柜时可删除
  assert.equal(document.querySelector('[data-act="del-case"]').disabled, false);

  // 添加灯到上限 8
  for (let k = 0; k < 5; k++) {
    document.querySelector('article.case [data-act="add-lamp"]')
      .dispatchEvent(new window.Event('click', { bubbles: true }));
  }
  const art = document.querySelector('article.case');
  assert.equal(art.querySelectorAll('.lamp').length, 8);
  assert.equal(art.querySelector('[data-act="add-lamp"]').disabled, true);
});
