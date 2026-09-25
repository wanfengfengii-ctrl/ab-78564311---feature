// 复核编排：校验通过后逐柜计算累计剂量、最长滑动窗口剂量与照度变化，
// 并按「展柜输入顺序 → 违规窗口起点」稳定确定首项证据。
import {
  Rat, validateDraft, collectIntervals, buildSegments,
  totalDose, maxSlidingDose, firstExceedance,
} from './light.js';

// 草稿内容指纹：仅依赖输入内容（与编辑顺序、id 无关也无妨——字段值变即失效）
export function draftFingerprint(draft) {
  return JSON.stringify(normalize(draft));
}
function normalize(v) {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((o, k) => {
      if (k === 'id') return o; // 行/灯/柜的内部 id 不影响结论
      o[k] = normalize(v[k]);
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
