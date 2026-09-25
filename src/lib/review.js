// 复核编排：校验通过后逐柜计算累计剂量、最长滑动窗口剂量与照度变化，
// 并按「展柜输入顺序 → 违规窗口起点」稳定确定首项证据。
import {
  Rat, validateDraft, validateRecovery, collectIntervals, buildSegments,
  totalDose, maxSlidingDose, firstExceedance, recoverBurden,
} from './light.js';

// 剂量复核指纹：恢复参数（recoveryRate/burdenLimit）不参与——补充或修改
// 恢复参数不得使已合格的剂量复核结论失效；其余字段值变即失效。
export function draftFingerprint(draft) {
  return JSON.stringify(normalize(draft, SKIP_DOSE));
}
// 恢复复核指纹：覆盖完整草稿（含恢复参数）——草稿或恢复参数改动即失效。
export function recoveryFingerprint(draft) {
  return JSON.stringify(normalize(draft, SKIP_ID));
}
const SKIP_ID = new Set(['id']); // 行/灯/柜的内部 id 不影响结论
const SKIP_DOSE = new Set(['id', 'recoveryRate', 'burdenLimit']);
function normalize(v, skip) {
  if (Array.isArray(v)) return v.map((x) => normalize(x, skip));
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((o, k) => {
      if (skip.has(k)) return o;
      o[k] = normalize(v[k], skip);
      return o;
    }, {});
  }
  return typeof v === 'string' ? v.trim() : v;
}

export function analyzeCase(cs) {
  const intervals = collectIntervals(cs);
  const segs = buildSegments(intervals);
  const L = Rat.read(cs.winLen);
  const winLimit = Rat.read(cs.winLimit);
  const totalLimit = Rat.read(cs.totalLimit);

  const total = totalDose(segs);
  const totalExceeded = total.gt(totalLimit);

  const win = maxSlidingDose(segs, L);
  const winExceeded = win.max.gt(winLimit);
  const crossing = winExceeded ? firstExceedance(segs, L, winLimit) : null;

  return {
    name: cs.name,
    scheduleStart: segs.length ? segs[0].t : null,
    scheduleEnd: segs.length ? segs[segs.length - 1].end : null,
    schedulePieces: withEvents(segs, intervals),
    total: {
      dose: total,
      limit: totalLimit,
      exceeded: totalExceeded,
    },
    window: {
      length: L,
      limit: winLimit,
      maxDose: win.max,
      start: win.start,
      end: win.end,
      pieces: win.empty ? [] : withEvents(win.pieces, intervals),
      note: win.note,
      exceeded: winExceeded,
      crossing,
    },
  };
}

// 为每个分段标注起点处的灯号联动事件（左闭右开：到 off 即熄灭）
function withEvents(pieces, intervals) {
  return pieces.map((p) => {
    const on = [], off = [];
    for (const iv of intervals) {
      if (iv.on.eq(p.t)) on.push(iv.lamp);
      if (iv.off.eq(p.t)) off.push(iv.lamp);
    }
    return { ...p, onLamps: on, offLamps: off };
  });
}

// 返回 { ok, errors, reports, passed, firstEvidence, at }
export function runReview(draft) {
  const v = validateDraft(draft);
  if (!v.ok) return { ok: false, errors: v.errors };

  const reports = draft.cases.map(analyzeCase);
  const violations = [];
  reports.forEach((r, ci) => {
    if (r.total.exceeded) {
      violations.push({
        caseIdx: ci,
        caseName: r.name,
        kind: 'total',
        start: r.scheduleStart ?? Rat.ZERO, // 累计：完整展期窗口，起点为最早点亮时刻
        sortKey: 0,
      });
    }
    if (r.window.exceeded) {
      violations.push({
        caseIdx: ci,
        caseName: r.name,
        kind: 'window',
        start: r.window.crossing?.crossing ?? r.window.start,
        sortKey: 1,
      });
    }
  });
  // 稳定排序：展柜输入顺序优先，其次违规窗口起点（精确有理数比较）
  violations.sort((a, b) =>
    a.caseIdx - b.caseIdx ||
    a.start.cmp(b.start) ||
    a.sortKey - b.sortKey);

  const first = violations[0] || null;
  let firstEvidence = null;
  if (first) {
    const r = reports[first.caseIdx];
    if (first.kind === 'total') {
      firstEvidence = {
        caseIdx: first.caseIdx,
        caseName: first.caseName,
        kind: 'total',
        windowStart: r.scheduleStart,
        windowEnd: r.scheduleEnd,
        dose: r.total.dose,
        limit: r.total.limit,
      };
    } else {
      firstEvidence = {
        caseIdx: first.caseIdx,
        caseName: first.caseName,
        kind: 'window',
        length: r.window.length,
        windowStart: first.start,
        doseAtStart: r.window.crossing?.dose ?? null,
        limit: r.window.limit,
        strictlyAfter: Boolean(r.window.crossing?.strictlyAfter),
        maxWindow: { start: r.window.start, end: r.window.end, dose: r.window.maxDose },
      };
    }
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

/* ---------------- 恢复复核：总剂量合格但短时连续照射未能恢复的辨别 ---------------- */
//
// 前提：剂量复核已取得合格结论（由调用方保证）。逐柜自记录范围起点以零负担
// 推演残余负担，任一时刻越过允许负担即判该柜未恢复；首项证据按
// 「展柜输入顺序 → 首次越限时刻」稳定确定。
// 返回 { ok, errors, reports, violations, passed, firstEvidence, at }
export function runRecoveryReview(draft) {
  const vd = validateDraft(draft);
  if (!vd.ok) return { ok: false, scope: 'dose', errors: vd.errors };
  const vr = validateRecovery(draft);
  if (!vr.ok) return { ok: false, scope: 'recovery', errors: vr.errors };

  const reports = draft.cases.map((cs) => {
    const segs = buildSegments(collectIntervals(cs));
    const rate = Rat.read(cs.recoveryRate);
    const limit = Rat.read(cs.burdenLimit);
    const rec = recoverBurden(segs, rate, limit);
    return {
      name: cs.name,
      rate,
      limit,
      scheduleStart: segs.length ? segs[0].t : null,
      scheduleEnd: segs.length ? segs[segs.length - 1].end : null,
      segments: rec.segments,
      peak: rec.peak,
      exceeded: rec.exceeded,
      crossing: rec.crossing,
    };
  });

  const violations = [];
  reports.forEach((r, ci) => {
    if (r.exceeded) violations.push({ caseIdx: ci, caseName: r.name, at: r.crossing.at });
  });
  // 稳定排序：展柜输入顺序优先，其次首次越限时刻（精确有理数比较）
  violations.sort((a, b) => a.caseIdx - b.caseIdx || a.at.cmp(b.at));

  const first = violations[0] || null;
  let firstEvidence = null;
  if (first) {
    const r = reports[first.caseIdx];
    firstEvidence = {
      caseIdx: first.caseIdx,
      caseName: first.caseName,
      crossing: first.at,          // 首次越限的精确临界时刻
      iuv: r.crossing.iuv,         // 越限时的照度
      burden: r.crossing.burden,   // 恢复后的残余负担（恰达允许负担）
      limit: r.limit,
      rate: r.rate,
      peak: r.peak,
      strictlyAfter: r.crossing.strictlyAfter,
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
