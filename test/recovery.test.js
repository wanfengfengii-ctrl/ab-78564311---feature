import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Rat, validateRecovery, collectIntervals, buildSegments, recoverBurden,
} from '../src/lib/light.js';
import {
  runReview, runRecoveryReview, draftFingerprint, recoveryFingerprint,
} from '../src/lib/review.js';

const R = (s) => Rat.read(s);
const segsOf = (lamps) => buildSegments(collectIntervals({ lamps }));

/* ---------------- 残余负担推演：累积 / 连续衰减 / 零下限 ---------------- */

test('恢复推演：照射累积、按恢复系数连续衰减、段内降至 0 后保持', () => {
  // [0,2) i=3；[2,6) i=1；k=2
  const segs = segsOf([
    { no: 'A', rows: [{ on: '0', off: '2', iuv: '3' }] },
    { no: 'B', rows: [{ on: '2', off: '6', iuv: '1' }] },
    { no: 'C', rows: [{ on: '0', off: '6', iuv: '0' }] },
  ]);
  const rec = recoverBurden(segs, R('2'), R('100'));
  assert.equal(rec.segments.length, 2);
  // 段1：斜率 3−2=1，0 → 2
  assert.ok(rec.segments[0].startBurden.eq(R('0')));
  assert.ok(rec.segments[0].endBurden.eq(R('2')));
  assert.equal(rec.segments[0].zeroAt, null);
  // 段2：斜率 1−2=−1，2 经 2h 于 t=4 降至 0 并保持
  assert.ok(rec.segments[1].startBurden.eq(R('2')));
  assert.ok(rec.segments[1].endBurden.eq(R('0')));
  assert.ok(rec.segments[1].zeroAt.eq(R('4')));
  // 峰值 2，发生于 t=2
  assert.ok(rec.peak.burden.eq(R('2')));
  assert.ok(rec.peak.at.eq(R('2')));
  assert.equal(rec.exceeded, false);
  assert.equal(rec.crossing, null);
});

test('恢复推演：斜率为 0 时负担保持不变；峰值同值取最早发生时刻', () => {
  // [0,1) i=2，[1,2) i=1（斜率 0），[2,3) i=2，[3,4) i=0；k=1
  const segs = segsOf([
    { no: 'A', rows: [{ on: '0', off: '1', iuv: '2' }, { on: '2', off: '3', iuv: '2' }] },
    { no: 'B', rows: [{ on: '1', off: '2', iuv: '1' }] },
    { no: 'C', rows: [{ on: '0', off: '4', iuv: '0' }] },
  ]);
  const rec = recoverBurden(segs, R('1'), R('100'));
  assert.deepEqual(
    rec.segments.map((s) => [s.startBurden.toString(), s.endBurden.toString()]),
    [['0', '1'], ['1', '1'], ['1', '2'], ['2', '1']],
  );
  // 峰值 2 仅在 t=3 取得
  assert.ok(rec.peak.burden.eq(R('2')));
  assert.ok(rec.peak.at.eq(R('3')));
});

test('恢复推演：峰值同值时保留最早发生时刻', () => {
  // [0,1) i=2，[1,2) i=0，[2,3) i=2，[3,4) i=0；k=1 → 峰值 1 在 t=1 与 t=3 两次取得
  const segs = segsOf([
    { no: 'A', rows: [{ on: '0', off: '1', iuv: '2' }, { on: '2', off: '3', iuv: '2' }] },
    { no: 'B', rows: [{ on: '0', off: '4', iuv: '0' }] },
    { no: 'C', rows: [{ on: '0', off: '4', iuv: '0' }] },
  ]);
  const rec = recoverBurden(segs, R('1'), R('100'));
  assert.ok(rec.peak.burden.eq(R('1')));
  assert.ok(rec.peak.at.eq(R('1')), `got ${rec.peak.at}`);
});

/* ---------------- 首次越限：精确时刻、越限照度、恢复后的负担 ---------------- */

test('首次越限：段内一次方程精确求解，标明越限照度与恢复后的负担', () => {
  // [0,4) i=3；k=1，限额 4 → B(t)=2t，恰于 t=2 达到限额、之后越限
  const segs = segsOf([
    { no: 'A', rows: [{ on: '0', off: '4', iuv: '3' }] },
    { no: 'B', rows: [{ on: '0', off: '4', iuv: '0' }] },
    { no: 'C', rows: [{ on: '0', off: '4', iuv: '0' }] },
  ]);
  const rec = recoverBurden(segs, R('1'), R('4'));
  assert.equal(rec.exceeded, true);
  assert.ok(rec.crossing.at.eq(R('2')));
  assert.ok(rec.crossing.iuv.eq(R('3')));      // 越限时照度
  assert.ok(rec.crossing.burden.eq(R('4')));   // 恢复后的负担（恰达限额）
  assert.equal(rec.crossing.strictlyAfter, true);
  // 限额 8：段末恰达限额但未越过 → 不越限
  assert.equal(recoverBurden(segs, R('1'), R('8')).exceeded, false);
  // 限额 7.9：t = 7.9/2 = 3.95
  const rec2 = recoverBurden(segs, R('1'), R('7.9'));
  assert.ok(rec2.crossing.at.eq(R('3.95')));
});

test('首次越限：段起点恰达限额后继续上升，越限时刻为该段起点', () => {
  // [0,2) i=3（B: 0→4），[2,4) i=2（斜率 1，4→6）；k=1，限额 4
  const segs = segsOf([
    { no: 'A', rows: [{ on: '0', off: '2', iuv: '3' }] },
    { no: 'B', rows: [{ on: '2', off: '4', iuv: '2' }] },
    { no: 'C', rows: [{ on: '0', off: '4', iuv: '0' }] },
  ]);
  const rec = recoverBurden(segs, R('1'), R('4'));
  assert.equal(rec.exceeded, true);
  assert.ok(rec.crossing.at.eq(R('2')));
  assert.ok(rec.crossing.iuv.eq(R('2')));
  assert.equal(rec.crossing.strictlyAfter, true);
});

test('首次越限：先降后升，越限发生在上升段内精确位置', () => {
  // [0,1) i=3（B: 0→2），[1,3) i=0（B: 2→0），[3,6) i=2（斜率 1，0→3）；k=1，限额 2.5
  const segs = segsOf([
    { no: 'A', rows: [{ on: '0', off: '1', iuv: '3' }] },
    { no: 'B', rows: [{ on: '3', off: '6', iuv: '2' }] },
    { no: 'C', rows: [{ on: '0', off: '6', iuv: '0' }] },
  ]);
  const rec = recoverBurden(segs, R('1'), R('2.5'));
  assert.equal(rec.exceeded, true);
  assert.ok(rec.crossing.at.eq(R('5.5')), `got ${rec.crossing.at}`);
  assert.ok(rec.crossing.iuv.eq(R('2')));
});

/* ---------------- 恢复参数校验：缺失 / 非有限 / 非正 / 限额不合理，一次列出 ---------------- */

function validCase(name, extra = {}) {
  return {
    name, winLen: '2', winLimit: '9', totalLimit: '100',
    recoveryRate: '1', burdenLimit: '5',
    lamps: [
      { no: 'A', rows: [{ on: '0', off: '2', iuv: '1' }] },
      { no: 'B', rows: [{ on: '0', off: '2', iuv: '1' }] },
      { no: 'C', rows: [{ on: '0', off: '2', iuv: '1' }] },
    ],
    ...extra,
  };
}

test('恢复参数非法：缺失、非有限、非正、限额不合理一次列出并阻止复核', () => {
  const draft = { cases: [
    validCase('甲', { recoveryRate: '', burdenLimit: 'abc' }),   // 缺失 + 非有限
    validCase('乙', { recoveryRate: '-2', burdenLimit: '0' }),   // 非正 + 非正
    validCase('丙', { recoveryRate: '1.5', burdenLimit: '200' }), // 限额 > 累计上限 100，不合理
  ] };
  const v = validateRecovery(draft);
  assert.equal(v.ok, false);
  assert.equal(v.errors.length, 5);
  const msgs = v.errors.map((e) => e.msg).join('\n');
  assert.match(msgs, /恢复系数缺失/);
  assert.match(msgs, /“abc”不是有限数值/);
  assert.match(msgs, /恢复系数必须为正/);
  assert.match(msgs, /允许残余负担限额必须为正/);
  assert.match(msgs, /允许残余负担（200）大于累计剂量上限（100），负担限额不合理/);
  // 阻止恢复复核
  const run = runRecoveryReview(draft);
  assert.equal(run.ok, false);
  assert.equal(run.scope, 'recovery');
  assert.equal(run.errors.length, 5);
});

test('恢复参数合法边界：正小数系数与限额可复核；0 与非数值被拒', () => {
  assert.equal(validateRecovery({ cases: [validCase('甲'), validCase('乙')] }).ok, true);
  assert.equal(validateRecovery({ cases: [validCase('甲', { recoveryRate: '0' }), validCase('乙')] }).ok, false);
  assert.equal(validateRecovery({ cases: [validCase('甲', { burdenLimit: '1e5' }), validCase('乙')] }).ok, false);
});

/* ---------------- 恢复复核编排：稳定首项证据 ---------------- */

test('首项证据按展柜输入顺序优先，再按首次越限时刻；结果稳定可复现', () => {
  // 三柜照度均恒为 3（[0,4)）：甲 k=1 限额 3 → t=1.5 越限；乙合规；丙 k=0.5 限额 2 → t=0.8 越限
  const draft = { cases: [
    validCase('甲', { recoveryRate: '1', burdenLimit: '3', lamps: [
      { no: 'A', rows: [{ on: '0', off: '4', iuv: '1' }] },
      { no: 'B', rows: [{ on: '0', off: '4', iuv: '1' }] },
      { no: 'C', rows: [{ on: '0', off: '4', iuv: '1' }] },
    ] }),
    validCase('乙', { recoveryRate: '1', burdenLimit: '100' }),
    validCase('丙', { recoveryRate: '0.5', burdenLimit: '2', lamps: [
      { no: 'A', rows: [{ on: '0', off: '4', iuv: '1' }] },
      { no: 'B', rows: [{ on: '0', off: '4', iuv: '1' }] },
      { no: 'C', rows: [{ on: '0', off: '4', iuv: '1' }] },
    ] }),
  ] };
  // 前提：剂量复核合格
  assert.equal(runReview(draft).passed, true);

  const r = runRecoveryReview(draft);
  assert.equal(r.ok, true);
  assert.equal(r.passed, false);
  assert.equal(r.violations.length, 2);
  // 丙越限更早（0.8 < 1.5），但展柜输入顺序优先 → 甲为首项证据
  const e = r.firstEvidence;
  assert.equal(e.caseIdx, 0);
  assert.equal(e.caseName, '甲');
  assert.ok(e.crossing.eq(R('1.5')));
  assert.ok(e.iuv.eq(R('3')));
  assert.ok(e.burden.eq(R('3')));
  assert.ok(e.limit.eq(R('3')));
  assert.ok(e.peak.burden.eq(R('8')));
  // 确定性：再算一次完全一致
  const r2 = runRecoveryReview(draft);
  assert.equal(r2.firstEvidence.caseIdx, 0);
  assert.ok(r2.firstEvidence.crossing.eq(R('1.5')));
  // 逐柜报告：峰值、发生时刻、每段起止负担齐备
  assert.ok(r.reports[0].peak.at.eq(R('4')));
  assert.equal(r.reports[0].segments.length, 1);
  assert.ok(r.reports[0].segments[0].startBurden.eq(R('0')));
  assert.ok(r.reports[0].segments[0].endBurden.eq(R('8')));
});

test('恢复复核全部合规则通过', () => {
  const r = runRecoveryReview({ cases: [validCase('甲'), validCase('乙')] });
  assert.equal(r.passed, true);
  assert.equal(r.firstEvidence, null);
  assert.equal(r.reports.length, 2);
});

/* ---------------- 指纹：恢复参数只使恢复结论失效，不影响剂量结论 ---------------- */

test('恢复参数改动：剂量指纹不变、恢复指纹失效；剂量字段改动两者皆失效', () => {
  const draft = { cases: [validCase('甲'), validCase('乙')] };
  const fpDose = draftFingerprint(draft);
  const fpRec = recoveryFingerprint(draft);

  draft.cases[0].recoveryRate = '2';
  assert.equal(draftFingerprint(draft), fpDose, '恢复参数不得影响剂量复核结论');
  assert.notEqual(recoveryFingerprint(draft), fpRec, '恢复参数改动须使恢复结论失效');

  const fpRec2 = recoveryFingerprint(draft);
  draft.cases[0].burdenLimit = '6';
  assert.equal(draftFingerprint(draft), fpDose);
  assert.notEqual(recoveryFingerprint(draft), fpRec2);

  draft.cases[0].winLimit = '8';
  assert.notEqual(draftFingerprint(draft), fpDose, '剂量字段改动须使剂量结论失效');
  assert.notEqual(recoveryFingerprint(draft), fpRec2, '剂量字段改动同样使恢复结论失效');
});

/* ---------------- 本地保存：恢复结论持久化与失效 ---------------- */

test('存储：恢复复核结论持久化、重开可续；恢复参数改动仅恢复结论失效', async () => {
  const m = new Map();
  globalThis.localStorage = {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
  const storage = await import('../src/lib/storage.js');

  const draft = { cases: [validCase('甲'), validCase('乙')] };
  storage.saveDraft(draft);
  const review = runReview(draft);
  assert.equal(review.passed, true);
  storage.saveReview(draft, review);
  const rec = runRecoveryReview(draft);
  assert.equal(rec.ok, true);
  storage.saveRecovery(draft, rec);

  // 重新打开：剂量与恢复结论均可恢复，Rat 被精确还原
  const reopened = storage.loadDraft();
  assert.ok(storage.loadReview(reopened), '剂量结论应恢复');
  const loadedRec = storage.loadRecovery(reopened);
  assert.ok(loadedRec, '恢复结论应恢复');
  assert.equal(loadedRec.recovery.passed, true);
  assert.equal(loadedRec.recovery.reports[0].peak.burden.constructor.name, 'Rat');
  assert.equal(loadedRec.recovery.reports[0].peak.burden.toString(), '4'); // i=3、k=1，2h 净累积 (3−1)×2

  // 恢复参数改动：剂量结论仍有效，恢复结论失效
  reopened.cases[0].recoveryRate = '2';
  assert.ok(storage.loadReview(reopened), '恢复参数改动不得影响剂量结论');
  assert.equal(storage.loadRecovery(reopened), null, '恢复参数改动须使恢复结论失效');

  // 剂量字段改动：两者皆失效
  const again = storage.loadDraft();
  again.cases[0].winLimit = '8';
  assert.equal(storage.loadReview(again), null);
  assert.equal(storage.loadRecovery(again), null);
});
