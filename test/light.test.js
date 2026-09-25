import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Rat, validateDraft, makeDraft, makeCase, makeLamp, makeLampRow,
  collectIntervals, buildSegments, totalDose, maxSlidingDose, firstExceedance,
} from '../src/lib/light.js';
import { runReview, draftFingerprint } from '../src/lib/review.js';

const R = (s) => Rat.read(s);

/* ---------------- 有理数精确性 ---------------- */

test('Rat: 0.1+0.2 精确等于 0.3，无浮点误差', () => {
  assert.ok(R('0.1').add(R('0.2')).eq(R('0.3')));
  assert.ok(R('0.0000001').add(R('0.0000002')).eq(R('0.0000003')));
  assert.equal(R('1').sub(R('0.9')).toString(), '0.1');
  assert.equal(R('2').div(R('8')).toString(), '0.25');
});

/* ---------------- 分段叠加（左闭右开） ---------------- */

test('左闭右开：同一时刻熄灭与点亮衔接，照度精确切换', () => {
  const cs = {
    lamps: [
      { no: 'A', rows: [{ on: '0', off: '2', iuv: '3' }] },
      { no: 'B', rows: [{ on: '2', off: '4', iuv: '5' }] },
      { no: 'C', rows: [{ on: '0', off: '4', iuv: '1' }] },
    ],
  };
  const segs = buildSegments(collectIntervals(cs));
  assert.equal(segs.length, 2);
  assert.ok(segs[0].iuv.eq(R('4'))); // [0,2): 3+1
  assert.ok(segs[1].iuv.eq(R('6'))); // [2,4): 5+1
});

test('多灯同段照度求和与总剂量', () => {
  const cs = {
    lamps: [
      { no: 'A', rows: [{ on: '0', off: '10', iuv: '2' }] },
      { no: 'B', rows: [{ on: '3', off: '7', iuv: '1.5' }] },
      { no: 'C', rows: [{ on: '5', off: '12', iuv: '0.5' }] },
    ],
  };
  const segs = buildSegments(collectIntervals(cs));
  // [0,3)=2  [3,5)=3.5  [5,7)=4  [7,10)=2.5  [10,12)=0.5
  const vals = ['2', '3.5', '4', '2.5', '0.5'];
  assert.deepEqual(segs.map((s) => s.iuv.toString()), vals);
  // 6 + 7 + 8 + 7.5 + 1 = 29.5
  assert.ok(totalDose(segs).eq(R('29.5')));
});

/* ---------------- 滑动窗口精确最大值：与密集网格对照 ---------------- */

function gridDose(intervals, s, L) {
  // 参考实现：起点取自固定网格，窗口内积分按区间精确裁剪求
  const e = s + L;
  let d = 0;
  for (const iv of intervals) {
    const a = Math.max(iv.a, s);
    const b = Math.min(iv.b, e);
    if (b > a) d += iv.i * (b - a);
  }
  return d;
}

function toIntervals(cs) {
  return collectIntervals(cs).map((iv) => ({ a: +iv.on.toString(), b: +iv.off.toString(), i: +iv.iuv.toString() }));
}

function pseudoRandom(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904273) >>> 0;
    return x / 4294967296;
  };
}

test('随机对照：精确最大窗口剂量不被任何网格点超越，且与网格上界一致', () => {
  const rand = pseudoRandom(42);
  for (let trial = 0; trial < 24; trial++) {
    const nLamp = 3 + Math.floor(rand() * 6);
    const lamps = [];
    for (let k = 0; k < nLamp; k++) {
      const rows = [];
      const nRows = 1 + Math.floor(rand() * 2);
      for (let r = 0; r < nRows; r++) {
        const a = Math.floor(rand() * 90) / 10;
        const b = a + (1 + Math.floor(rand() * 40)) / 10;
        rows.push({ on: a.toFixed(1), off: b.toFixed(1), iuv: String(Math.floor(rand() * 6)) });
      }
      lamps.push({ no: `L${k}`, rows });
    }
    const cs = { lamps };
    const segs = buildSegments(collectIntervals(cs));
    const intervalsN = toIntervals(cs);
    // |D'(s)|=|i(s+L)−i(s)| 不超过各灯照度总和（分段常数叠加），用于网格误差界
    const lipBound = intervalsN.reduce((s, iv) => s + iv.i, 0) || 1;
    for (const Lstr of ['1.5', '2', '3.7']) {
      const L = R(Lstr);
      const win = maxSlidingDose(segs, L);
      const exact = +win.max.toString();
      const sMin = intervalsN.reduce((m, iv) => Math.min(m, iv.a), Infinity);
      const sMax = intervalsN.reduce((m, iv) => Math.max(m, iv.b), -Infinity) - +Lstr;
      // 网格扫描（仅起点用固定网格——这正是应用被禁止采用的做法）
      let approx = 0;
      const h = 0.002;
      if (sMax >= sMin) {
        for (let s = sMin; s <= sMax + 1e-9; s += h) {
          approx = Math.max(approx, gridDose(intervalsN, s, +Lstr));
        }
      }
      // 精确解必须 >= 任何采样值
      assert.ok(exact >= approx - 1e-9, `trial ${trial} L ${Lstr}: exact ${exact} < grid ${approx}`);
      // 且不得高出网格一个离散步长可能造成的误差（D(s) 的斜率有界）
      assert.ok(exact - approx <= lipBound * h + 1e-9,
        `trial ${trial} L ${Lstr}: gap ${exact - approx} too large`);
      // 报出的窗口积分必须自洽
      const check = gridDose(intervalsN, +win.start.toString(), +Lstr);
      assert.ok(Math.abs(check - exact) <= 1e-9);
    }
  }
});

test('解析案例：最大窗口位置与剂量精确', () => {
  // i=1 on [0,2), i=2 on [2,6)
  const cs = { lamps: [
    { no: 'A', rows: [{ on: '0', off: '2', iuv: '1' }] },
    { no: 'B', rows: [{ on: '2', off: '6', iuv: '2' }] },
    { no: 'C', rows: [{ on: '0', off: '6', iuv: '0' }] },
  ] };
  const segs = buildSegments(collectIntervals(cs));
  const win = maxSlidingDose(segs, R('2'));
  assert.ok(win.max.eq(R('4')));
  assert.ok(win.start.eq(R('2'))); // 最早取得最大值的起点
  assert.ok(win.end.eq(R('4')));
});

test('首超点：分段线性上精确解方程，不依赖采样', () => {
  // i=1 on [0,2), i=2 on [2,6)，L=2，limit=3.5 → crossing=1.5
  const cs = { lamps: [
    { no: 'A', rows: [{ on: '0', off: '2', iuv: '1' }] },
    { no: 'B', rows: [{ on: '2', off: '6', iuv: '2' }] },
    { no: 'C', rows: [{ on: '0', off: '6', iuv: '0' }] },
  ] };
  const segs = buildSegments(collectIntervals(cs));
  const ex = firstExceedance(segs, R('2'), R('3.5'));
  assert.ok(ex.crossing.eq(R('1.5')), `got ${ex.crossing.toString()}`);
  assert.ok(ex.strictlyAfter === true);
  // 恰在临界等于限额：limit=3 → crossing=1
  const ex2 = firstExceedance(segs, R('2'), R('3'));
  assert.ok(ex2.crossing.eq(R('1')));
  // 不超限
  assert.equal(firstExceedance(segs, R('2'), R('4.1')), null);
});

test('窗口长于点亮时段：完整覆盖窗口（含前后零照度留白），剂量等于总剂量', () => {
  const cs = { lamps: [
    { no: 'A', rows: [{ on: '1', off: '3', iuv: '2' }] },
    { no: 'B', rows: [{ on: '1', off: '3', iuv: '2' }] },
    { no: 'C', rows: [{ on: '1', off: '3', iuv: '2' }] },
  ] };
  const segs = buildSegments(collectIntervals(cs));
  const win = maxSlidingDose(segs, R('10'));
  // 点亮仅 [1,3)，照度合计 6，总剂量 6×2 = 12；窗口其余 8 小时照度为 0
  assert.ok(win.max.eq(R('12')));
  assert.ok(win.start.eq(R('0')));
  assert.ok(win.end.eq(R('10')));
  // 分段完整覆盖窗口且连续衔接
  assert.ok(win.pieces[0].t.eq(R('0')));
  assert.ok(win.pieces[win.pieces.length - 1].end.eq(R('10')));
  for (let k = 1; k < win.pieces.length; k++) assert.ok(win.pieces[k].t.eq(win.pieces[k - 1].end));
});

test('无任何分段：窗口剂量为 0', () => {
  const win = maxSlidingDose([], R('2'));
  assert.ok(win.max.eq(Rat.ZERO));
  assert.equal(win.start, null);
  assert.deepEqual(win.pieces, []);
});

test('首超点：起点即超限', () => {
  const cs = { lamps: [
    { no: 'A', rows: [{ on: '0', off: '10', iuv: '1' }] },
    { no: 'B', rows: [{ on: '0', off: '10', iuv: '1' }] },
    { no: 'C', rows: [{ on: '0', off: '10', iuv: '1' }] },
  ] };
  const segs = buildSegments(collectIntervals(cs));
  const ex = firstExceedance(segs, R('2'), R('5'));
  assert.ok(ex.crossing.eq(R('0')));
});

/* ---------------- 校验：一次列出全部错误并阻止复核 ---------------- */

test('非法项一次性全部列出', () => {
  const draft = makeDraft();
  draft.cases = [
    { name: '甲', winLen: '0', winLimit: '5', totalLimit: '3', lamps: [
      { no: 'X', rows: [{ on: '5', off: '2', iuv: '1' }] },
      { no: 'X', rows: [{ on: '0', off: '2', iuv: 'abc' }] },
      { no: '', rows: [{ on: '0', off: '2', iuv: '1' }] },
    ] },
    { name: '乙', winLen: '2', winLimit: '', totalLimit: '10', lamps: [
      { no: 'A', rows: [{ on: '0', off: '2', iuv: '1' }] },
      { no: 'B', rows: [{ on: '0', off: '2', iuv: '1' }] },
    ] },
  ];
  const v = validateDraft(draft);
  assert.equal(v.ok, false);
  const msgs = v.errors.map((e) => e.msg).join('\n');
  assert.match(msgs, /窗口长度必须大于 0/);
  assert.match(msgs, /窗口剂量限额.*大于累计上限/);
  assert.match(msgs, /停止时刻.*必须晚于启动时刻/);
  assert.match(msgs, /紫外线照度缺失或非法/);
  assert.match(msgs, /灯号“X”重复/);
  assert.match(msgs, /缺少灯号/);
  assert.match(msgs, /窗口剂量限额缺失/);
  assert.match(msgs, /灯的数量应为 3–8/);
  // 阻止复核
  const run = runReview(draft);
  assert.equal(run.ok, false);
  assert.ok(run.errors.length >= 8);
});

test('同一盏灯区间重叠非法，端点相接合法（左闭右开）', () => {
  const bad = validateDraft({ cases: [
    { name: '甲', winLen: '2', winLimit: '9', totalLimit: '100', lamps: [
      { no: 'A', rows: [{ on: '0', off: '3', iuv: '1' }, { on: '2', off: '4', iuv: '1' }] },
      { no: 'B', rows: [{ on: '0', off: '2', iuv: '1' }] },
      { no: 'C', rows: [{ on: '0', off: '2', iuv: '1' }] },
    ] },
    { name: '乙', winLen: '2', winLimit: '9', totalLimit: '100', lamps: [
      { no: 'A', rows: [{ on: '0', off: '2', iuv: '1' }] },
      { no: 'B', rows: [{ on: '2', off: '4', iuv: '1' }] },
      { no: 'C', rows: [{ on: '0', off: '2', iuv: '1' }] },
    ] },
  ] });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0].msg, /时间重叠/);

  const good = validateDraft({ cases: [
    { name: '甲', winLen: '2', winLimit: '9', totalLimit: '100', lamps: [
      { no: 'A', rows: [{ on: '0', off: '2', iuv: '1' }, { on: '2', off: '4', iuv: '1' }] },
      { no: 'B', rows: [{ on: '0', off: '4', iuv: '1' }] },
      { no: 'C', rows: [{ on: '0', off: '4', iuv: '1' }] },
    ] },
    { name: '乙', winLen: '2', winLimit: '9', totalLimit: '100', lamps: [
      { no: 'A', rows: [{ on: '0', off: '2', iuv: '1' }] },
      { no: 'B', rows: [{ on: '2', off: '4', iuv: '1' }] },
      { no: 'C', rows: [{ on: '0', off: '2', iuv: '1' }] },
    ] },
  ] });
  assert.equal(good.ok, true);
});

test('展柜数量边界 2–6、灯 3–8', () => {
  const mk = (nc, nl) => ({
    cases: Array.from({ length: nc }, (_, ci) => ({
      name: `C${ci}`, winLen: '2', winLimit: '9', totalLimit: '100',
      lamps: Array.from({ length: nl }, (_, li) => ({
        no: `L${li}`, rows: [{ on: '0', off: '2', iuv: '1' }],
      })),
    })),
  });
  assert.equal(validateDraft(mk(1, 3)).ok, false);
  assert.equal(validateDraft(mk(2, 3)).ok, true);
  assert.equal(validateDraft(mk(6, 8)).ok, true);
  assert.equal(validateDraft(mk(7, 8)).ok, false);
  assert.equal(validateDraft(mk(3, 2)).ok, false);
  assert.equal(validateDraft(mk(3, 9)).ok, false);
});

/* ---------------- 复核编排：稳定首项证据 ---------------- */

function passingCase(name, total = '100', win = '9') {
  return {
    name, winLen: '2', winLimit: win, totalLimit: total,
    lamps: [
      { no: 'A', rows: [{ on: '0', off: '2', iuv: '1' }] },
      { no: 'B', rows: [{ on: '0', off: '2', iuv: '1' }] },
      { no: 'C', rows: [{ on: '0', off: '2', iuv: '1' }] },
    ],
  };
}

test('首项证据按展柜输入顺序优先，再按违规窗口起点', () => {
  const draft = { cases: [
    passingCase('甲'), // 总剂量 6，窗口 6，通过
    // 乙柜：窗口超限，最早违规起点 1.5
    {
      name: '乙', winLen: '2', winLimit: '3.5', totalLimit: '100',
      lamps: [
        { no: 'A', rows: [{ on: '0', off: '2', iuv: '1' }] },
        { no: 'B', rows: [{ on: '2', off: '6', iuv: '2' }] },
        { no: 'C', rows: [{ on: '0', off: '6', iuv: '0' }] },
      ],
    },
  ] };
  const r = runReview(draft);
  assert.equal(r.ok, true);
  assert.equal(r.passed, false);
  assert.equal(r.firstEvidence.caseIdx, 1);
  assert.ok(r.firstEvidence.windowStart.eq(R('1.5')));
  // 确定性：再算一次完全一致
  const r2 = runReview(draft);
  assert.ok(r2.firstEvidence.windowStart.eq(r.firstEvidence.windowStart));
  assert.equal(r2.firstEvidence.caseIdx, r.firstEvidence.caseIdx);
});

test('累计超限排在同柜窗口违规之前、且按柜顺序', () => {
  const overTotal = passingCase('超限柜', '1', '0.5'); // 总剂量 6 > 1（窗口 6 > 0.5 同样违规）
  const draft = { cases: [passingCase('正常柜'), overTotal] };
  const r = runReview(draft);
  assert.equal(r.firstEvidence.kind, 'total');
  assert.equal(r.firstEvidence.caseIdx, 1);
  assert.ok(r.firstEvidence.dose.eq(R('6')));
});

test('全部合规则通过', () => {
  const r = runReview({ cases: [passingCase('甲'), passingCase('乙')] });
  assert.equal(r.passed, true);
  assert.equal(r.firstEvidence, null);
  assert.equal(r.reports.length, 2);
});

/* ---------------- 指纹：草稿变更后旧结论失效 ---------------- */

test('草稿指纹随内容变化（旧结论必须失效）', () => {
  const draft = { cases: [passingCase('甲'), passingCase('乙')] };
  const fp1 = draftFingerprint(draft);
  draft.cases[0].lamps[0].rows[0].iuv = '1.1';
  assert.notEqual(draftFingerprint(draft), fp1);
  // 结构性增删同样变化
  const fp2 = draftFingerprint(draft);
  draft.cases.push(passingCase('丙'));
  assert.notEqual(draftFingerprint(draft), fp2);
});
