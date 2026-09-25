// 恢复复核：在剂量复核合格的前提下，逐柜推演纸张光损的「残余负担」。
//
// 连续时间模型（照射与恢复同时进行，全程连续，不做采样近似）：
//   dB/dt = i(t) − k·B(t)，  B(t0) = 0
//   t0 为该柜记录范围起点；i(t) 为所有灯左闭右开区间叠加后的分段恒定紫外照度；
//   k 为该柜纸张的光损恢复系数（h⁻¹）。负担恒不为负：黑暗中 B 仅向 0 衰减。
//
// 在每个照度恒定段 [t,end) 内有解析解：
//   B(u) = i/k + (B(t) − i/k)·e^(−k(u−t))，  u ∈ [t,end)
// 段内 B 关于时间单调，故段内峰值只可能出现在端点；首次越过限额的时刻
// 由 B(u)=limit 直接解出 u = t + ln((i/k−B(t))/(i/k−limit))/k（超越方程，
// 不存在有理闭式解，采用双精度计算，误差远低于 1e-9 h 的显示量级）。
import {
  Rat, validateDraft, collectIntervals, buildSegments,
} from './light.js';
import { withEvents } from './review.js';

/* ---------------- 恢复参数校验：一次列出全部问题并阻止恢复复核 ---------------- */

export function validateRecovery(draft) {
  const base = validateDraft(draft);
  const errors = [...base.errors];
  const add = (caseIdx, field, msg) => errors.push({ caseIdx, lampIdx: null, rowIdx: null, field, msg });

  if (draft && typeof draft === 'object' && Array.isArray(draft.cases)) {
    draft.cases.forEach((cs, ci) => {
      if (!cs || typeof cs !== 'object') return;
      const where = () => `第 ${ci + 1} 柜「${cs.name || '未命名'}」`;

      let k;
      try {
        k = Rat.read(cs.recovery);
      } catch {
        add(ci, 'recovery', `${where()}：光损恢复系数缺失或不是有限非负数值（h⁻¹）`);
      }
      if (k && k.isZero()) add(ci, 'recovery', `${where()}：光损恢复系数必须大于 0（完全不可恢复请填写极小的正数）`);

      let limit;
      try {
        limit = Rat.read(cs.residLimit);
      } catch {
        add(ci, 'residLimit', `${where()}：允许残余负担缺失或不是有限非负数值`);
      }
      if (limit && limit.isZero()) add(ci, 'residLimit', `${where()}：允许残余负担必须大于 0，限额不合理`);
      // 不强制 k、limit 与照度之间的数值关系：恢复复核本就是用来辨识
      // 「总剂量合格却因短时连续照射而未能恢复」的方案。
    });
  }

  errors.sort((a, b) =>
    (a.caseIdx ?? -1) - (b.caseIdx ?? -1) ||
    (a.lampIdx ?? -1) - (b.lampIdx ?? -1) ||
    (a.rowIdx ?? -1) - (b.rowIdx ?? -1));
  return { ok: errors.length === 0, errors };
}

/* ---------------- 精确有理数 ↔ 有限双精度（仅超越函数处使用） ---------------- */

// 任意 Rat（含 25/3 这类非有限小数，以及极端量级）→ 有限双精度。
// 取分子、分母各自前 15 位有效数字（均在 double 精确整数范围内）按位数差还原数量级，
// 不经过 BigInt→Number 的整体转换，避免溢出成 Infinity 后相除得 NaN。
function ratToNumber(r) {
  if (r.n === 0n) return 0;
  const ns = r.n.toString();
  const ds = r.d.toString();
  const P = 15;
  const na = Math.min(P, ns.length);
  const nb = Math.min(P, ds.length);
  const a = Number(ns.slice(0, na));
  const b = Number(ds.slice(0, nb));
  const x = (a / b) * 10 ** ((ns.length - na) - (ds.length - nb));
  return r.s < 0n ? -x : x;
}

// 双精度非负数 → 12 位小数截断的精确十进制 Rat
function numToRat(x) {
  if (!Number.isFinite(x) || x < 0) throw new Error('非法数值');
  const s = x.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  return Rat.fromString(s === '' ? '0' : s);
}

/* ---------------- 单柜恢复推演 ---------------- */
//
// 返回：
// { name, k, limit, scheduleStart, scheduleEnd, empty,
//   peak, peakAt, endBurden, exceeded, crossing,
//   pieces: [{t,end,iuv,startB,endB,onLamps,offLamps}] }
export function simulateRecovery(cs, k = Rat.read(cs.recovery), limit = Rat.read(cs.residLimit)) {
  const intervals = collectIntervals(cs);
  const segs = buildSegments(intervals);
  if (!segs.length) {
    return {
      name: cs.name, k, limit,
      scheduleStart: null, scheduleEnd: null, empty: true,
      peak: Rat.ZERO, peakAt: null, endBurden: Rat.ZERO,
      exceeded: false, crossing: null, pieces: [],
    };
  }

  const t0 = segs[0].t;
  let burden = Rat.ZERO; // B(t0) = 0：从记录范围起点零负担开始
  const pieces = [];
  let peak = Rat.ZERO;
  let peakAt = t0;
  let crossing = null;

  const considerPeak = (val, t) => {
    // 同值取最早时刻，保证可复现
    if (val.gt(peak)) { peak = val; peakAt = t; }
  };

  for (const sg of segs) {
    const startB = burden;
    const eq = sg.iuv.div(k);                  // 本段照度下的稳态负担 i/k
    const x0 = startB.sub(eq);                 // B(t)−i/k
    let endB;
    if (x0.isZero()) {
      endB = eq;
    } else {
      const decay = Math.exp(-ratToNumber(k.mul(sg.end.sub(sg.t)))); // e^(−k·Δt)
      endB = eq.add(x0.mul(numToRat(decay)));
      // 数值兜底：负担不得低于零（黑暗段 e^(−kΔt) 截断为 0 时自然得 0）
      if (endB.lt(Rat.ZERO)) endB = Rat.ZERO;
    }

    // 首次越限定位：段内 B 单调，越限（严格大于限额）只会在上升段发生。
    // B(u)=limit  ⇔  u−t = ln((i/k−B(t))/(i/k−limit))/k
    if (!crossing && endB.gt(limit)) {
      if (startB.gt(limit)) {
        // 防御性：进入本段时已越限（正常情况下上一段末即截获）
        crossing = { at: sg.t, burden: startB, strictlyAfter: false, iuv: sg.iuv };
      } else {
        const du = Math.log(ratToNumber(eq.sub(startB)) / ratToNumber(eq.sub(limit))) / ratToNumber(k);
        crossing = { at: sg.t.add(numToRat(du)), burden: limit, strictlyAfter: true, iuv: sg.iuv };
      }
    }

    considerPeak(startB, sg.t);
    considerPeak(endB, sg.end);
    pieces.push({ t: sg.t, end: sg.end, iuv: sg.iuv, startB, endB });
    burden = endB;
  }

  return {
    name: cs.name,
    k,
    limit,
    scheduleStart: t0,
    scheduleEnd: segs[segs.length - 1].end,
    empty: false,
    peak,
    peakAt,
    endBurden: burden,
    exceeded: Boolean(crossing),
    crossing: crossing
      ? { at: crossing.at, burden: crossing.burden, strictlyAfter: crossing.strictlyAfter, iuv: crossing.iuv }
      : null,
    pieces: withEvents(pieces, intervals),
  };
}

/* ---------------- 编排：按柜顺序 + 首次越限时刻稳定确定首项证据 ---------------- */

// 返回 { ok, errors, reports, violations, firstEvidence, passed, at }
export function runRecovery(draft) {
  const v = validateRecovery(draft);
  if (!v.ok) return { ok: false, errors: v.errors };

  const reports = draft.cases.map((cs) => simulateRecovery(cs));
  const violations = [];
  reports.forEach((r, ci) => {
    if (r.exceeded) violations.push({ caseIdx: ci, caseName: r.name, at: r.crossing.at });
  });
  // 稳定排序：展柜输入顺序优先，同柜按首次越限时刻升序
  violations.sort((a, b) => a.caseIdx - b.caseIdx || a.at.cmp(b.at));

  const first = violations[0] || null;
  let firstEvidence = null;
  if (first) {
    const r = reports[first.caseIdx];
    firstEvidence = {
      caseIdx: first.caseIdx,
      caseName: first.caseName,
      at: r.crossing.at,
      strictlyAfter: r.crossing.strictlyAfter,
      iuv: r.crossing.iuv,
      limit: r.limit,
      burden: r.crossing.burden,
      recoveredBurden: r.endBurden,
      scheduleEnd: r.scheduleEnd,
    };
  }

  return {
    ok: true,
    errors: [],
    reports,
    violations,
    firstEvidence,
    passed: violations.length === 0,
    at: new Date().toISOString(),
  };
}
