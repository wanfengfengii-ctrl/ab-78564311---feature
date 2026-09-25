// 纯逻辑：精确有理数 + 草稿校验 + 连续时间分段恒定照度叠加 + 滑动窗口精确积分。
// 时间单位：小时；照度单位：μW/cm²；剂量单位：μW·h/cm²。
// 全部计算使用 BigInt 有理数，任意中间步骤都不做浮点近似或固定采样。

let uidCounter = 0;
export const newId = () => `id-${Date.now().toString(36)}-${uidCounter++}`;

/* ---------------- 非负/带符号精确有理数 ---------------- */

function bgcd(a, b) {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b) { [a, b] = [b, a % b]; }
  return a || 1n;
}

export class Rat {
  constructor(num, den = 1n) {
    num = BigInt(num);
    den = BigInt(den);
    if (den === 0n) throw new Error('分母为零');
    let s = 1n;
    if (num < 0n) { s = -1n; num = -num; }
    if (den < 0n) { den = -den; }
    const g = bgcd(num, den);
    this.s = s;
    this.n = num / g;
    this.d = den / g;
  }

  static ZERO = new Rat(0n);

  static fromString(str) {
    const s = String(str).trim();
    if (!/^\d+(?:\.\d+)?$/.test(s)) throw new Error(`非法数值：${str}`);
    const [ip, fp = ''] = s.split('.');
    return new Rat(BigInt(ip + fp), 10n ** BigInt(fp.length));
  }

  // 接受字符串 / Rat / number（number 仅来自程序化构造，先转最短十进制串）
  static read(x) {
    if (x instanceof Rat) return x;
    if (typeof x === 'number') {
      if (!Number.isFinite(x) || x < 0) throw new Error('非法数值');
      return Rat.fromString(String(x));
    }
    return Rat.fromString(String(x ?? ''));
  }

  add(o) { return new Rat(this.s * this.n * o.d + o.s * o.n * this.d, this.d * o.d); }
  sub(o) { return new Rat(this.s * this.n * o.d - o.s * o.n * this.d, this.d * o.d); }
  mul(o) { return new Rat(this.s * o.s * this.n * o.n, this.d * o.d); }
  div(o) { return new Rat(this.s * o.s * this.n * o.d, this.d * o.n); }
  abs() { return this.s < 0 ? new Rat(this.n, this.d) : this; }

  cmp(o) {
    const a = this.s * this.n * o.d;
    const b = o.s * o.n * this.d;
    return a < b ? -1 : a > b ? 1 : 0;
  }
  lt(o) { return this.cmp(o) < 0; }
  lte(o) { return this.cmp(o) <= 0; }
  gt(o) { return this.cmp(o) > 0; }
  gte(o) { return this.cmp(o) >= 0; }
  eq(o) { return this.cmp(o) === 0; }
  isZero() { return this.n === 0n; }

  // 规范化分数的稳定键（供去重 Map 使用）
  get key() { return `${this.s}/${this.n}/${this.d}`; }

  // 有限十进制精确展开（输入均为有限小数，+−× 后分母只含因子 2、5，必然可除尽）
  toExactDecimal() {
    const k = decimalDigits(this.d);
    if (k < 0) return this.toFixed(12).replace(/0+$/, '').replace(/\.$/, '') + '…';
    const tenK = 10n ** BigInt(k);
    const v = this.n * (tenK / this.d) * (this.s < 0n ? -1n : 1n);
    const neg = v < 0n;
    const av = neg ? -v : v;
    const whole = av / tenK;
    const frac = String(av % tenK).padStart(k, '0').replace(/0+$/, '');
    return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''}`;
  }

  toFixed(p) {
    const scale = 10n ** BigInt(p);
    const v = this.s * this.n * scale;
    const rounded = (v >= 0n ? (v * 2n + this.d) : (v * 2n - this.d)) / (2n * this.d);
    const neg = rounded < 0n;
    const av = neg ? -rounded : rounded;
    return `${neg ? '-' : ''}${av / scale}.${String(av % scale).padStart(p, '0')}`;
  }

  toString() { return this.toExactDecimal(); }
}

// d=2^a·5^b 时返回 max(a,b)，否则返回 -1
function decimalDigits(d) {
  let a = 0, b = 0;
  while (d % 2n === 0n) { d /= 2n; a++; }
  while (d % 5n === 0n) { d /= 5n; b++; }
  return d === 1n ? Math.max(a, b) : -1;
}

/* ---------------- 草稿模型 ---------------- */

export function makeLampRow(on = '', off = '', iuv = '') {
  return { id: newId(), on, off, iuv };
}
export function makeLamp(no) {
  return { id: newId(), no: String(no), rows: [makeLampRow()] };
}
export function makeCase(idx) {
  return {
    id: newId(),
    name: `展柜${idx}`,
    winLen: '',
    winLimit: '',
    totalLimit: '',
    lamps: [makeLamp(1), makeLamp(2), makeLamp(3)],
  };
}
export function makeDraft() {
  return { version: 1, cases: [makeCase(1), makeCase(2)] };
}

/* ---------------- 校验：一次列出全部非法项，阻止复核 ---------------- */

export function validateDraft(draft) {
  const errors = [];
  const add = (caseIdx, lampIdx = null, rowIdx = null, field = null, msg = '') =>
    errors.push({ caseIdx, lampIdx, rowIdx, field, msg });

  if (!draft || typeof draft !== 'object' || !Array.isArray(draft.cases)) {
    return { ok: false, errors: [{ caseIdx: null, lampIdx: null, rowIdx: null, field: null, msg: '草稿结构损坏，无法复核' }] };
  }
  if (draft.cases.length < 2 || draft.cases.length > 6) {
    add(null, null, null, 'cases', `展柜数量应为 2–6 个，当前为 ${draft.cases.length} 个`);
  }

  draft.cases.forEach((cs, ci) => {
    if (!cs || typeof cs !== 'object') { add(ci, null, null, null, '展柜数据损坏'); return; }
    const where = () => `第 ${ci + 1} 柜「${cs.name || '未命名'}」`;

    let winLen, winLimit, totalLimit;
    try { winLen = Rat.read(cs.winLen); } catch { add(ci, null, null, 'winLen', `${where()}：滑动窗口长度缺失或不是非负数值`); }
    try { winLimit = Rat.read(cs.winLimit); } catch { add(ci, null, null, 'winLimit', `${where()}：窗口剂量限额缺失或不是非负数值`); }
    try { totalLimit = Rat.read(cs.totalLimit); } catch { add(ci, null, null, 'totalLimit', `${where()}：累计剂量上限缺失或不是非负数值`); }
    if (winLen && winLen.isZero()) add(ci, null, null, 'winLen', `${where()}：滑动窗口长度必须大于 0`);
    if (winLimit && winLimit.isZero()) add(ci, null, null, 'winLimit', `${where()}：窗口剂量限额必须大于 0`);
    if (totalLimit && totalLimit.isZero()) add(ci, null, null, 'totalLimit', `${where()}：累计剂量上限必须大于 0`);
    if (winLimit && totalLimit && winLimit.gt(totalLimit)) {
      add(ci, null, null, 'winLimit', `${where()}：窗口剂量限额（${winLimit}）大于累计上限（${totalLimit}），限额不合理`);
    }

    const lamps = Array.isArray(cs.lamps) ? cs.lamps : [];
    if (lamps.length < 3 || lamps.length > 8) {
      add(ci, null, null, 'lamps', `${where()}：灯的数量应为 3–8 盏，当前为 ${lamps.length} 盏`);
    }

    // 重复灯号（同一展柜内）
    const noSeen = new Map();
    lamps.forEach((lp, li) => {
      const no = String(lp?.no ?? '').trim();
      if (!no) return; // 空灯号另行报错
      if (noSeen.has(no)) {
        add(ci, li, null, 'no', `${where()}：灯号“${no}”重复（第 ${noSeen.get(no) + 1} 盏与第 ${li + 1} 盏）`);
      } else {
        noSeen.set(no, li);
      }
    });

    lamps.forEach((lp, li) => {
      if (!lp || typeof lp !== 'object' || !Array.isArray(lp.rows)) {
        add(ci, li, null, null, `${where()}：第 ${li + 1} 盏灯数据损坏`);
        return;
      }
      const lampLabel = String(lp.no ?? '').trim() || `#${li + 1}`;
      if (!String(lp.no ?? '').trim()) add(ci, li, null, 'no', `${where()}：第 ${li + 1} 盏灯缺少灯号`);
      if (lp.rows.length === 0) add(ci, li, null, 'rows', `${where()} 灯 ${lampLabel}：至少需要一个启停区间`);

      const parsed = [];
      lp.rows.forEach((r, ri) => {
        const tag = `${where()} 灯 ${lampLabel} 第 ${ri + 1} 段`;
        let on, off, iuv;
        try { on = Rat.read(r.on); } catch { add(ci, li, ri, 'on', `${tag}：启动时刻缺失或非法`); }
        try { off = Rat.read(r.off); } catch { add(ci, li, ri, 'off', `${tag}：停止时刻缺失或非法`); }
        try { iuv = Rat.read(r.iuv); } catch { add(ci, li, ri, 'iuv', `${tag}：紫外线照度缺失或非法`); }
        if (on && off && !on.lt(off)) {
          add(ci, li, ri, 'off', `${tag}：停止时刻（${off}）必须晚于启动时刻（${on}），区间为左闭右开 [on, off)`);
        }
        if (on && off && on.lt(off)) parsed.push({ on, off, ri });
      });

      // 同一盏灯的区间相互重叠即非法（端点相接合法：左闭右开 [a,b)∪[b,c)）
      parsed.sort((a, b) => {
        const c = a.on.cmp(b.on);
        return c !== 0 ? c : a.off.cmp(b.off);
      });
      for (let k = 1; k < parsed.length; k++) {
        if (parsed[k].on.lt(parsed[k - 1].off)) {
          add(ci, li, parsed[k].ri, 'on',
            `${where()} 灯 ${lampLabel}：第 ${parsed[k - 1].ri + 1} 段与第 ${parsed[k].ri + 1} 段时间重叠（同一盏灯不得同时开启两段）`);
        }
      }
    });
  });

  // 稳定排序：展柜顺序 → 灯顺序 → 行顺序，便于用户逐项处理
  errors.sort((a, b) =>
    (a.caseIdx ?? -1) - (b.caseIdx ?? -1) ||
    (a.lampIdx ?? -1) - (b.lampIdx ?? -1) ||
    (a.rowIdx ?? -1) - (b.rowIdx ?? -1));

  return { ok: errors.length === 0, errors };
}

/* ---------------- 连续时间：叠加为分段恒定照度 ---------------- */

export function collectIntervals(cs) {
  const out = [];
  cs.lamps.forEach((lp) => {
    const lamp = String(lp.no).trim();
    lp.rows.forEach((r) => {
      const on = Rat.read(r.on);
      const off = Rat.read(r.off);
      const iuv = Rat.read(r.iuv);
      if (on.lt(off)) out.push({ lamp, on, off, iuv });
    });
  });
  return out;
}

// 返回分段 [{t,end,iuv}]，半开区间 [t,end) 内所有开启灯的照度之和恒定。
// 完全在连续时间上精确切分，不以任何采样点近似。
export function buildSegments(intervals) {
  if (!intervals.length) return [];
  const cutIndex = new Map();
  for (const iv of intervals) {
    if (!cutIndex.has(iv.on.key)) cutIndex.set(iv.on.key, iv.on);
    if (!cutIndex.has(iv.off.key)) cutIndex.set(iv.off.key, iv.off);
  }
  const cuts = [...cutIndex.values()].sort((a, b) => a.cmp(b));
  const segs = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const t = cuts[k];
    const end = cuts[k + 1];
    let sum = Rat.ZERO;
    for (const iv of intervals) {
      // 左闭右开：iv 覆盖 [t,end) 当且仅当 on<=t 且 end<=off
      if (iv.on.lte(t) && end.lte(iv.off)) sum = sum.add(iv.iuv);
    }
    segs.push({ t, end, iuv: sum });
  }
  return segs;
}

export function totalDose(segs) {
  let d = Rat.ZERO;
  for (const s of segs) d = d.add(s.iuv.mul(s.end.sub(s.t)));
  return d;
}

/* ---------------- 连续滑动窗口的精确最大积分剂量 ---------------- */
//
// i(t) 在切点 c0<…<cm 之间分段恒定，窗口剂量 D(s)=∫_[s,s+L) i(t)dt。
// 在相邻“临界起点”之间 i(s) 与 i(s+L) 均恒定，故 D'(s)=i(s+L)−i(s) 恒定，
// D 为线性函数，其闭区间上的最大值必在端点取得。临界起点恰为
// {c_k} ∪ {c_k − L}（分别对应窗口左端、右端撞上照度变化点）。
// 因此只需在有限的、精确的候选起点上求值；不使用任何固定采样网格。
// 同值时取最早起点，保证证据稳定可复现。
export function maxSlidingDose(segs, L) {
  if (!segs.length) {
    return { max: Rat.ZERO, start: null, end: null, pieces: [], empty: true };
  }
  const t0 = segs[0].t;
  const tN = segs[segs.length - 1].end;
  const cuts = [t0, ...segs.map((s) => s.end)];
  const pref = [Rat.ZERO];
  for (const s of segs) pref.push(pref[pref.length - 1].add(s.iuv.mul(s.end.sub(s.t))));
  const cutPos = new Map(cuts.map((c, k) => [c.key, k]));

  // F(t)=∫_{t0}^{t} i：t 落在某分段内部时按该段常系数精确补齐
  const F = (t) => {
    const hit = cutPos.get(t.key);
    if (hit !== undefined) return pref[hit];
    let lo = 0, hi = cuts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cuts[mid].lte(t)) lo = mid; else hi = mid - 1;
    }
    const j = lo; // t ∈ [cuts[j], cuts[j+1])
    return pref[j].add(segs[j].iuv.mul(t.sub(cuts[j])));
  };
  const windowDose = (a, b) => F(b).sub(F(a));

  // 窗口比整个有点灯光的时域还长：窗外照度恒为 0，
  // 任一完整覆盖 [t0,tN] 的窗口剂量都等于总剂量；取不早于 0 的最早窗口。
  if (L.gte(tN.sub(t0))) {
    const start = tN.sub(L).lt(Rat.ZERO) ? Rat.ZERO : tN.sub(L);
    return {
      max: pref[pref.length - 1],
      start,
      end: start.add(L),
      pieces: piecesBetween(segs, start, start.add(L)),
      empty: false,
      note: L.gt(tN.sub(t0)) ? '窗口长于全部点亮时段，窗口起止之外紫外照度为 0' : null,
    };
  }

  const sMin = t0;
  const sMax = tN.sub(L);
  const candidates = [];
  const pushCand = (s) => {
    if (s.lte(sMax) && sMin.lte(s)) candidates.push(s);
  };
  for (const c of cuts) {
    pushCand(c);         // 窗口左端撞变化点
    pushCand(c.sub(L));  // 窗口右端撞变化点
  }
  candidates.sort((a, b) => a.cmp(b));

  let best = null;
  for (const s of candidates) {
    const e = s.add(L);
    const d = windowDose(s, e);
    if (!best || d.gt(best.d)) best = { s, e, d };
    // 等值不覆盖：候选已按起点升序，天然保留最早起点
  }

  return { max: best.d, start: best.s, end: best.e, pieces: piecesBetween(segs, best.s, best.e), empty: false };
}

// 求窗口剂量 D(s) 首次达到/越过限额的精确临界起点。
// 在相邻临界起点之间 D 为线性，故对每一段解一次一次方程即可精确定位，
// 不枚举采样点。返回 {crossing, dose, after}：crossing 为 D(crossing)=limit
// 的精确时刻，严格超限区间为 (crossing, …]；若起点本身已超限则 crossing=起点。
export function firstExceedance(segs, L, limit) {
  if (!segs.length) return null;
  const t0 = segs[0].t;
  const tN = segs[segs.length - 1].end;
  if (L.gte(tN.sub(t0))) {
    // 窗口剂量与起点无关（恒为总剂量）
    const total = totalDose(segs);
    return total.gt(limit) ? { crossing: Rat.ZERO, dose: total, flat: true } : null;
  }
  const cuts = [t0, ...segs.map((s) => s.end)];
  const pref = [Rat.ZERO];
  for (const s of segs) pref.push(pref[pref.length - 1].add(s.iuv.mul(s.end.sub(s.t))));
  const cutPos = new Map(cuts.map((c, k) => [c.key, k]));
  const F = (t) => {
    const hit = cutPos.get(t.key);
    if (hit !== undefined) return pref[hit];
    let lo = 0, hi = cuts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cuts[mid].lte(t)) lo = mid; else hi = mid - 1;
    }
    return pref[lo].add(segs[lo].iuv.mul(t.sub(cuts[lo])));
  };
  const windowDose = (a, b) => F(b).sub(F(a));

  const sMin = t0;
  const sMax = tN.sub(L);
  const set = new Map();
  for (const c of cuts) {
    if (c.lte(sMax) && sMin.lte(c)) set.set(c.key, c);
    const d = c.sub(L);
    if (d.lte(sMax) && sMin.lte(d)) set.set(d.key, d);
  }
  const pts = [...set.values()].sort((a, b) => a.cmp(b));

  for (let k = 0; k < pts.length; k++) {
    const s = pts[k];
    const d = windowDose(s, s.add(L));
    if (d.gt(limit)) return { crossing: s, dose: d, flat: false };
    if (k + 1 >= pts.length) break;
    const s2 = pts[k + 1];
    const d2 = windowDose(s2, s2.add(L));
    // (s,s2] 上 D 线性
    if (d2.gt(limit)) {
      if (d.gt(limit)) return { crossing: s, dose: d, flat: false };
      if (d.eq(limit)) return { crossing: s, dose: d, flat: false, strictlyAfter: true };
      // slope>0；解 s* = s + (limit−d)·(s2−s)/(d2−d)
      const num = limit.sub(d).mul(s2.sub(s));
      const crossing = s.add(num.div(d2.sub(d)));
      return { crossing, dose: limit, flat: false, strictlyAfter: true };
    }
  }
  return null;
}

// 窗口 [a,b) 内的照度变化序列（完整覆盖窗口；合并相邻同值分段）
function piecesBetween(segs, a, b) {
  const raw = [];
  for (const sg of segs) {
    if (sg.end.lte(a) || b.lte(sg.t)) continue;
    const t = sg.t.lt(a) ? a : sg.t;
    const end = b.lt(sg.end) ? b : sg.end;
    raw.push({ t, end, iuv: sg.iuv });
  }
  // 补齐窗口内点亮时段之前/之后的零照度留白
  if (raw.length) {
    if (a.lt(raw[0].t)) raw.unshift({ t: a, end: raw[0].t, iuv: Rat.ZERO });
    if (raw[raw.length - 1].end.lt(b)) raw.push({ t: raw[raw.length - 1].end, end: b, iuv: Rat.ZERO });
  }
  const merged = [];
  for (const p of raw) {
    const last = merged[merged.length - 1];
    if (last && last.end.eq(p.t) && last.iuv.eq(p.iuv)) last.end = p.end;
    else merged.push(p);
  }
  return merged;
}
