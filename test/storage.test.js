import { test } from 'node:test';
import assert from 'node:assert/strict';

// 浏览器 localStorage 的最小内存实现
function installLocalStorageStub() {
  const m = new Map();
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
}

test('存储：草稿与最近有效复核持久化、重开可续调，改动即失效', async () => {
  installLocalStorageStub();
  const storage = await import('../src/lib/storage.js');
  const { makeDraft } = await import('../src/lib/light.js');
  const { runReview } = await import('../src/lib/review.js');

  const draft = makeDraft();
  for (const cs of draft.cases) {
    cs.winLen = '2';
    cs.winLimit = '9';
    cs.totalLimit = '100';
    cs.lamps.forEach((lp) => { lp.rows[0].on = '0'; lp.rows[0].off = '2'; lp.rows[0].iuv = '1'; });
  }
  storage.saveDraft(draft);
  const review = runReview(draft);
  assert.equal(review.passed, true);
  storage.saveReview(draft, review);

  // 重新打开：草稿与结论均可恢复，Rat 被精确还原
  const reopened = storage.loadDraft();
  const loaded = storage.loadReview(reopened);
  assert.ok(loaded, '应能恢复最近一次有效复核');
  assert.equal(loaded.review.passed, true);
  const dose = loaded.review.reports[0].total.dose;
  assert.equal(dose.constructor.name, 'Rat');
  assert.equal(dose.toString(), '6'); // 3 灯 × 1 μW × 2 h

  // 草稿变更：旧结论不得继续显示
  reopened.cases[0].winLimit = '9.5';
  assert.equal(storage.loadReview(reopened), null);
});
