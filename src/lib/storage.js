// 本机持久化：草稿与最近一次有效复核结果保存在浏览器 localStorage。
// 复核结果带草稿指纹；草稿一旦变更（指纹不符），旧结论立即失效、不再显示。
import { Rat, makeDraft } from './light.js';
import { draftFingerprint } from './review.js';

const DRAFT_KEY = 'paper-light:draft:v1';
const REVIEW_KEY = 'paper-light:review:v1';

export function loadDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return makeDraft();
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.cases)) return makeDraft();
    return d;
  } catch {
    return makeDraft();
  }
}

export function saveDraft(draft) {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

// 仅保存“有效复核”（校验通过、成功算出的结论，无论通过与否）
export function saveReview(draft, review) {
  localStorage.setItem(REVIEW_KEY, JSON.stringify({
    fingerprint: draftFingerprint(draft),
    at: review.at,
    review: serializeReview(review),
  }));
}

export function loadReview(draft) {
  try {
    const raw = localStorage.getItem(REVIEW_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw, reviver);
    // 草稿变更后旧结论不得继续显示：指纹不符即作废
    if (!parsed || parsed.fingerprint !== draftFingerprint(draft)) return null;
    return { at: parsed.at, review: parsed.review };
  } catch {
    return null;
  }
}

export function clearReview() {
  localStorage.removeItem(REVIEW_KEY);
}

// Rat（字段含 bigint）无法直接 JSON 化，以 {__rat:'s/n/d'} 中转
function serializeReview(review) {
  return JSON.parse(JSON.stringify(review, (_k, v) => {
    if (v instanceof Rat) return { __rat: `${v.s}/${v.n}/${v.d}` };
    return v;
  }));
}

function reviver(_k, v) {
  if (v && typeof v === 'object' && typeof v.__rat === 'string') {
    const [s, n, d] = v.__rat.split('/');
    return new Rat(BigInt(s) * BigInt(n), BigInt(d));
  }
  return v;
}
