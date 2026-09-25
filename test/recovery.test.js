import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rat, makeCase } from '../src/lib/light.js';
import {
  validateRecovery, simulateRecovery, runRecovery,
} from '../src/lib/recovery.js';
import { draftFingerprint, recoveryFingerprint } from '../src/lib/review.js';

const R = (s) => Rat.read(s);
const num = (r) => parseFloat(r.toFixed(12));

// 三盏灯的合法草稿；lit=[on,off,iuv] 为第 1 盏灯的区间，
// 其余两盏使用同一时段的零照度合法区间（不改变叠加照度与分段结构）。
function caseSpec({ name = '甲', recovery = '1', residLimit = '100',
                    winLen = '2', winLimit = '100', totalLimit = '1000',
                    lit = [0, 1, 3], lamps = null } = {}) {
  const ls = lamps ?? [
    lit,
    [lit[0], lit[1], 0],
    [lit[0], lit[1], 0],
  ];
  return {
    name, recovery, residLimit, winLen, winLimit, totalLimit,
    lamps: ls.map(([on, off, iuv], li) => ({
      no: `L${li}`, rows: [{ on: String(on), off: String(off), iuv: String(iuv) }],
    })),
  };
}

/* ---------------- 连续模型：起算、闭式解、衰减非负 ---------------- */

test('恢复推演：从记录范围起点零负担开始，单段解析解精确', () => {
  // [0,2) i=3, k=1 → B(t)=3(1−e^−t)；B(0)=0，B(2)=3(1−e^−2)=2.593994…
  const r = simulateRecovery(caseSpec({ lit: [0, 2, 3] }));
  assert.ok(r.pieces[0].startB.isZero());
  assert.ok(r.scheduleStart.eq(R('0')));
  assert.ok(Math.abs(num(r.pieces[0].endB) - 3 * (1 - Math.exp(-2))) < 1e-9);
  assert.ok(Math.abs(num(r.peak) - 3 * (1 - Math.exp(-2))) < 1e-9);
});

test('黑暗段负担连续衰减且永不低于零（含极长间隔的数值归零）', () => {
  // [0,1) i=3 → B(1)=1.896…；[1,100) 黑暗 → e^−99≈0，负担归零
  const r = simulateRecovery(caseSpec({
    lamps: [[0, 1, 3], [1, 100, 0], [0, 1, 0]],
  }));
  assert.equal(r.pieces.length, 2);
  assert.ok(r.pieces[1].startB.eq(r.pieces[0].endB)); // 段间连续
  assert.ok(r.pieces[1].endB.isZero());
  assert.ok(!r.endBurden.lt(Rat.ZERO));
  for (const p of r.pieces) {
    assert.ok(!p.startB.lt(Rat.ZERO) && !p.endB.lt(Rat.ZERO));
  }
  // 再照射从衰减后的残余负担继续累积
  const r2 = simulateRecovery(caseSpec({
    lamps: [[0, 1, 3], [1, 2, 0], [2, 3, 3]],
  }));
  assert.ok(r2.pieces[2].startB.gt(Rat.ZERO));
});

test('段间衔接负担相等（连续性），峰值在段端点取得', () => {
  const r = simulateRecovery(caseSpec({
    lamps: [[0, 1, 3], [1, 2, 1], [2, 4, 5]],
  }));
  for (let k = 1; k < r.pieces.length; k++) {
    assert.ok(r.pieces[k].startB.eq(r.pieces[k - 1].endB));
  }
  // 每段内 B 单调，峰值必为某段端点值
  const ends = r.pieces.flatMap((p) => [p.startB, p.endB]);
  assert.ok(ends.some((b) => b.eq(r.peak)));
});

/* ---------------- 首次越限：剂量合格却短时连续照射被辨识 ---------------- */

test('首越限时刻由 B(u)=限额 解析定位，并标注越限照度', () => {
  // i=10 on [0,1), k=0.5，稳态 20；限额 7
  // 1−e^(−0.5t)=0.35 → t=−2·ln(0.65)=0.86157…
  const r = simulateRecovery(caseSpec({
    recovery: '0.5', residLimit: '7', lit: [0, 1, 10],
  }));
  assert.equal(r.exceeded, true);
  assert.ok(Math.abs(num(r.crossing.at) - -2 * Math.log(0.65)) < 1e-9,
    `got ${r.crossing.at}`);
  assert.equal(r.crossing.strictlyAfter, true);
  assert.ok(r.crossing.iuv.eq(R('10')));
  assert.ok(r.crossing.burden.eq(R('7')));
});

test('总剂量/窗口剂量均合格，仍可因短时连续照射恢复不通过', () => {
  // i=10 on [0,1)，随后 [1,3) 黑暗恢复：总剂量 10；限额都给足 → 剂量合格
  // 残余负担峰值 7.87 > 7 → 恢复复核不通过；展期结束 B(3)=B(1)·e^−1≈2.9 已低于限额
  const mk = (name) => caseSpec({
    name, recovery: '0.5', residLimit: '7', winLimit: '100', totalLimit: '1000',
    lamps: [[0, 1, 10], [1, 3, 0], [0, 3, 0]],
  });
  const res = runRecovery({ cases: [mk('甲'), mk('乙')] });
  assert.equal(res.ok, true);
  assert.equal(res.passed, false);
  assert.equal(res.firstEvidence.caseIdx, 0);
  assert.ok(Math.abs(num(res.firstEvidence.at) - -2 * Math.log(0.65)) < 1e-9);
  // 越限照度与恢复后负担都在证据中
  assert.ok(res.firstEvidence.iuv.eq(R('10')));
  assert.ok(res.firstEvidence.recoveredBurden.lt(R('7')));
});

test('照射短、负担未达限额时通过（即使总剂量不小）', () => {
  // i=10 on [0,0.5)：峰值 20(1−e^−0.25)=4.42 < 7
  const r = simulateRecovery(caseSpec({
    recovery: '0.5', residLimit: '7', lit: [0, 0.5, 10],
  }));
  assert.equal(r.exceeded, false);
  assert.equal(r.crossing, null);
  assert.ok(r.peak.lt(R('7')));
});

test('恰在段末达到限额不算越限；限额略低于段末负担时越限点逼近段末', () => {
  // i=3, k=1 on [0,2)；取限额 = 真实 B(2)−1e-9（严格低于段末负担）
  const base = simulateRecovery(caseSpec({ recovery: '1', residLimit: '99', lit: [0, 2, 3] }));
  const bEnd = base.pieces[0].endB;
  const limit = bEnd.sub(Rat.read('0.000000001'));
  const r = simulateRecovery(caseSpec({
    recovery: '1', residLimit: limit.toExactDecimal(), lit: [0, 2, 3],
  }));
  assert.equal(r.exceeded, true);
  assert.ok(Math.abs(num(r.crossing.at) - 2) < 1e-6);

  // 限额恰等于段末负担：负担只在 t=2 这一时刻取到限额，不算越过
  const r2 = simulateRecovery(caseSpec({
    recovery: '1', residLimit: bEnd.toExactDecimal(), lit: [0, 2, 3],
  }));
  assert.equal(r2.exceeded, false, '恰好取等不应判定为越限');
});

test('无有效点亮区间：负担恒为 0，合规', () => {
  const r = simulateRecovery({
    name: '空', recovery: '1', residLimit: '5',
    lamps: [
      { no: 'A', rows: [{ on: '5', off: '2', iuv: '1' }] },  // 停止早于启动：被跳过
      { no: 'B', rows: [{ on: '0', off: '0', iuv: '3' }] },  // 零长区间：被跳过
      { no: 'C', rows: [{ on: '2', off: '2', iuv: '1' }] },
    ],
  });
  assert.equal(r.empty, true);
  assert.equal(r.exceeded, false);
  assert.ok(r.peak.isZero());
  assert.deepEqual(r.pieces, []);
});

/* ---------------- 首项证据稳定性：柜顺序 → 首次越限时刻 ---------------- */

test('首项证据按展柜输入顺序优先，再按首次越限时刻', () => {
  const firstCase = caseSpec({ name: '先柜', recovery: '0.5', residLimit: '7',
    lit: [0, 1, 10] });                                    // 越限 ~0.86
  const secondCase = caseSpec({ name: '后柜', recovery: '1', residLimit: '1',
    lit: [0, 1, 10] });                                   // 越限更早 ~0.105
  const res = runRecovery({ cases: [firstCase, secondCase] });
  assert.equal(res.passed, false);
  // 柜顺序优先于越限时刻：即便后柜越限更早，首项仍是第 1 柜
  assert.equal(res.firstEvidence.caseIdx, 0);
  assert.ok(Math.abs(num(res.firstEvidence.at) - -2 * Math.log(0.65)) < 1e-9);
  // 确定性：再算一次完全一致
  const res2 = runRecovery({ cases: [firstCase, secondCase] });
  assert.ok(res2.firstEvidence.at.eq(res.firstEvidence.at));
});

test('同柜多次越限取首次（首越限后仍继续推演全时段）', () => {
  // [0,1) i=10（首次越限 ~0.86），长期黑暗恢复，[10,11) 再次照射
  const r = simulateRecovery(caseSpec({
    recovery: '0.5', residLimit: '7',
    lamps: [[0, 1, 10], [1, 10, 0], [10, 11, 10]],
  }));
  assert.equal(r.exceeded, true);
  assert.ok(num(r.crossing.at) < 1);
  // 全段都被推演（每段起止负担齐全）
  assert.equal(r.pieces.length, 3);
  assert.ok(r.pieces[2].end.eq(R('11')));
});

/* ---------------- 校验：恢复参数缺失/非有限/非正/限额不合理 一次列出并阻止 ---------------- */

test('恢复参数问题一次全部列出，且基础草稿问题一并阻止复核', () => {
  const draft = { cases: [
    { name: '甲', winLen: '0', winLimit: '9', totalLimit: '100',
      recovery: '0', residLimit: '-3', // 非正恢复系数 + 非法（负）限额
      lamps: [
        { no: 'A', rows: [{ on: '0', off: '2', iuv: '1' }] },
        { no: 'B', rows: [{ on: '0', off: '2', iuv: '1' }] },
        { no: '', rows: [{ on: '0', off: '2', iuv: '1' }] },
      ] },
    { name: '乙', winLen: '2', winLimit: '9', totalLimit: '100',
      recovery: 'abc', residLimit: '', // 非有限恢复系数 + 缺失限额
      lamps: [
        { no: 'A', rows: [{ on: '0', off: '2', iuv: '1' }] },
        { no: 'B', rows: [{ on: '0', off: '2', iuv: '1' }] },
        { no: 'C', rows: [{ on: '0', off: '2', iuv: '1' }] },
      ] },
  ] };
  const v = validateRecovery(draft);
  assert.equal(v.ok, false);
  const msgs = v.errors.map((e) => e.msg).join('\n');
  assert.match(msgs, /恢复系数必须大于 0/);
  assert.match(msgs, /允许残余负担.*非负数值|允许残余负担缺失/);
  assert.match(msgs, /恢复系数缺失或不是有限非负数值/);
  assert.match(msgs, /允许残余负担缺失/);
  assert.match(msgs, /窗口长度必须大于 0/); // 基础剂量校验问题仍列出
  // 阻止复核
  const run = runRecovery(draft);
  assert.equal(run.ok, false);
  assert.ok(run.errors.length >= 5);
});

test('恢复系数/限额为 Infinity、NaN 等非有限字面量被拦截', () => {
  const cs = makeCase(1);
  cs.winLen = '2'; cs.winLimit = '9'; cs.totalLimit = '100';
  cs.recovery = 'NaN'; cs.residLimit = 'Infinity';
  const v = validateRecovery({ cases: [cs, caseSpec({ name: '乙' })] });
  assert.equal(v.ok, false);
  const msgs = v.errors.map((e) => e.msg).join('\n');
  assert.match(msgs, /恢复系数缺失或不是有限非负数值/);
  assert.match(msgs, /允许残余负担缺失或不是有限非负数值/);
});

test('允许残余负担为 0 属于不合理限额，被拦截', () => {
  const v = validateRecovery({ cases: [
    caseSpec({ name: '甲', residLimit: '0' }),
    caseSpec({ name: '乙' }),
  ] });
  assert.equal(v.ok, false);
  assert.match(v.errors.map((e) => e.msg).join('\n'), /允许残余负担必须大于 0/);
});

test('i/k 为非有限小数（k=0.12 → 25/3）时越限定位仍精确不抛错', () => {
  // 回归：超越方程求值需把任意有理数（含循环小数）稳健转为双精度
  const r = simulateRecovery(caseSpec({
    recovery: '0.12', residLimit: '1', lit: [0, 2, 1],
  }));
  assert.equal(r.exceeded, true);
  // B(t)=(1/0.12)(1−e^−0.12t)=1 → t=−ln(0.88)/0.12
  assert.ok(Math.abs(num(r.crossing.at) - -Math.log(0.88) / 0.12) < 1e-9);
  assert.ok(r.crossing.iuv.eq(R('1')));
});

test('全部合法时恢复复核通过并逐柜出报告', () => {  const res = runRecovery({ cases: [
    caseSpec({ name: '甲', recovery: '1', residLimit: '10' }),
    caseSpec({ name: '乙', recovery: '2', residLimit: '10' }),
  ] });
  assert.equal(res.ok, true);
  assert.equal(res.passed, true);
  assert.equal(res.firstEvidence, null);
  assert.equal(res.reports.length, 2);
  assert.ok(res.reports[0].k.eq(R('1')));
  assert.ok(res.reports[1].k.eq(R('2')));
});

/* ---------------- 指纹：恢复参数只使恢复结论失效 ---------------- */

test('恢复参数变化只改变恢复指纹，不影响剂量指纹', () => {
  const draft = { cases: [
    caseSpec({ name: '甲', recovery: '1', residLimit: '10' }),
    caseSpec({ name: '乙', recovery: '1', residLimit: '10' }),
  ] };
  const doseFp1 = draftFingerprint(draft);
  const recFp1 = recoveryFingerprint(draft);
  draft.cases[0].recovery = '0.5';
  assert.equal(draftFingerprint(draft), doseFp1, '剂量指纹应忽略恢复参数');
  assert.notEqual(recoveryFingerprint(draft), recFp1, '恢复指纹应随恢复参数变化');
  // 剂量输入变化则两种指纹都变
  const recFp2 = recoveryFingerprint(draft);
  draft.cases[0].lamps[0].rows[0].iuv = '4';
  assert.notEqual(draftFingerprint(draft), doseFp1);
  assert.notEqual(recoveryFingerprint(draft), recFp2);
});
