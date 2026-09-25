import { test } from 'node:test';
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

function click(document, sel) {
  document.querySelector(sel).dispatchEvent(new window.Event('click', { bubbles: true }));
}

function fillValidDraft(document) {
  // 默认 2 柜 × 3 灯 × 1 行；逐字段现查现设（每柜照度合计恒为 3，[0,2)）
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

function passDoseReview(document) {
  fillValidDraft(document);
  click(document, '#btn-review');
  assert.match(document.querySelector('#verdict').textContent, /复核通过/);
}

function fillRecoveryParams(document, rate, limit) {
  document.querySelectorAll('article.case').forEach((art) => {
    const ci = art.dataset.ci;
    setValue(document, `[data-ci="${ci}"][data-field="recoveryRate"]`, rate);
    setValue(document, `[data-ci="${ci}"][data-field="burdenLimit"]`, limit);
  });
}

test('DOM：剂量复核合格前不出现恢复入口，合格后开放恢复参数与按钮', async () => {
  const { document } = await freshEnv();
  assert.equal(document.querySelectorAll('[data-field="recoveryRate"]').length, 0);
  assert.equal(document.getElementById('btn-recovery').hidden, true);

  passDoseReview(document);
  assert.equal(document.getElementById('btn-recovery').hidden, false);
  // 每柜各一组恢复参数输入
  assert.equal(document.querySelectorAll('[data-field="recoveryRate"]').length, 2);
  assert.equal(document.querySelectorAll('[data-field="burdenLimit"]').length, 2);
});

test('DOM：恢复复核通过，逐柜给出峰值、发生时刻与每段起止负担', async () => {
  const { document } = await freshEnv();
  passDoseReview(document);
  // i=3 恒定 [0,2)，k=1 → 负担 0→4；限额 5 不越限
  fillRecoveryParams(document, '1', '5');
  click(document, '#btn-recovery');

  assert.match(document.querySelector('#recovery-verdict').textContent, /恢复复核通过/);
  const reports = document.querySelectorAll('.recovery-report');
  assert.equal(reports.length, 2);
  // 峰值 4，最早发生于 t=2
  assert.match(reports[0].textContent, /峰值残余负担[\s\S]*4[\s\S]*最早发生于[\s\S]*2/);
  // 每段起止负担：段始 0、段末 4
  const rows = reports[0].querySelectorAll('table.pieces tbody tr');
  assert.equal(rows.length, 1);
  const cells = rows[0].querySelectorAll('td');
  assert.equal(cells[3].textContent, '0');
  assert.equal(cells[4].textContent, '4');
});

test('DOM：恢复复核越限，首项证据标明越限时刻、越限时照度与恢复后的负担', async () => {
  const { document } = await freshEnv();
  passDoseReview(document);
  // k=1、限额 3：B(t)=2t 于 t=1.5 达限额，之后越限；越限时照度 3
  fillRecoveryParams(document, '1', '3');
  click(document, '#btn-recovery');

  assert.match(document.querySelector('#recovery-verdict').textContent, /恢复复核不通过/);
  const ev = document.querySelector('#recovery-verdict .evidence');
  assert.match(ev.textContent, /第 1 柜/);
  assert.match(ev.textContent, /首次越限时刻[\s\S]*1\.5/);
  assert.match(ev.textContent, /越限时照度[\s\S]*3/);
  assert.match(ev.textContent, /恢复后的残余负担[\s\S]*3/);
  // 逐柜报告同样给出越限信息
  assert.match(document.querySelector('.recovery-report').textContent, /首次越限时刻/);
});

test('DOM：恢复参数缺失、非有限、非正、限额不合理一次列出并阻止复核', async () => {
  const { document } = await freshEnv();
  passDoseReview(document);
  // 第 1 柜：系数缺失、限额非有限；第 2 柜：系数非正、限额大于累计上限（100）
  setValue(document, '[data-ci="0"][data-field="burdenLimit"]', 'abc');
  setValue(document, '[data-ci="1"][data-field="recoveryRate"]', '0');
  setValue(document, '[data-ci="1"][data-field="burdenLimit"]', '200');
  click(document, '#btn-recovery');

  const box = document.getElementById('recovery-errors');
  assert.equal(box.hidden, false);
  const text = box.textContent;
  assert.match(text, /恢复系数缺失/);
  assert.match(text, /不是有限数值/);
  assert.match(text, /恢复系数必须为正/);
  assert.match(text, /负担限额不合理/);
  // 阻止复核：无恢复结论横幅、无恢复报告
  assert.doesNotMatch(document.querySelector('#recovery-verdict').textContent, /恢复复核通过|恢复复核不通过/);
  assert.equal(document.querySelectorAll('.recovery-report').length, 0);
});

test('DOM：恢复参数改动后旧恢复结论立即消失，剂量结论保持有效', async () => {
  const { document } = await freshEnv();
  passDoseReview(document);
  fillRecoveryParams(document, '1', '5');
  click(document, '#btn-recovery');
  assert.match(document.querySelector('#recovery-verdict').textContent, /恢复复核通过/);

  // 改动恢复参数：恢复结论失效消失，剂量结论与报告保留
  setValue(document, '[data-ci="0"][data-field="recoveryRate"]', '1.5');
  assert.match(document.querySelector('#recovery-verdict').textContent, /恢复复核结论已失效/);
  assert.equal(document.querySelectorAll('.recovery-report').length, 0);
  assert.match(document.querySelector('#verdict').textContent, /复核通过/);
  assert.equal(document.querySelectorAll('article.case .report:not(.recovery-report)').length, 2);

  // 重新恢复复核：k=1.5 → 负担峰值 3 ≤ 5，通过
  click(document, '#btn-recovery');
  assert.match(document.querySelector('#recovery-verdict').textContent, /恢复复核通过/);
  assert.equal(document.querySelectorAll('.recovery-report').length, 2);
});

test('DOM：剂量相关草稿改动后，剂量与恢复结论一并失效', async () => {
  const { document } = await freshEnv();
  passDoseReview(document);
  fillRecoveryParams(document, '1', '5');
  click(document, '#btn-recovery');
  assert.match(document.querySelector('#recovery-verdict').textContent, /恢复复核通过/);

  // 改动剂量相关字段：两者皆失效，恢复入口随剂量结论一起隐藏
  setValue(document, '[data-ci="0"][data-li="0"][data-ri="0"][data-field="iuv"]', '1.2');
  assert.match(document.querySelector('#verdict').textContent, /复核结论已失效/);
  assert.equal(document.querySelector('#recovery-verdict').innerHTML, '');
  assert.equal(document.querySelectorAll('.report').length, 0);
  assert.equal(document.getElementById('btn-recovery').hidden, true);
  assert.equal(document.querySelectorAll('[data-field="recoveryRate"]').length, 0);
});
