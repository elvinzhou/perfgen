// Flight de-duplication helpers — no imports.
//
// The performance matrix AVERAGES every steady-state block across every
// uploaded flight, so uploading the same log twice silently biases the
// average toward that flight. To prevent that we fingerprint each CSV's
// content and skip a flight whose fingerprint we've already ingested.

// cyrb53 — a fast, well-distributed 53-bit string hash (non-cryptographic).
// We only need a stable fingerprint to recognise an identical file, not a
// security hash, so this avoids any SubtleCrypto / secure-context dependency
// and stays fully synchronous and testable.
export function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

// Fingerprint a CSV's content. Line endings and surrounding whitespace are
// normalised first so a re-export of the same flight that differs only in
// CRLF vs LF (or a trailing newline) is still recognised as a duplicate.
export function fingerprintCsv(text) {
  const normalized = String(text).replace(/\r\n?/g, '\n').trim();
  return cyrb53(normalized);
}

// ── Time-range de-duplication ─────────────────────────────────────────────────
//
// The same physical flight recorded on two G3X displays (separate SD cards)
// produces different bytes — and therefore different content fingerprints —
// because the units power up/down a few seconds apart. Their *time ranges*,
// however, overlap almost completely. We detect that overlap to treat them as
// one flight, so the shared cruise isn't averaged in twice.

// Fraction of two flights' overlapping interval over the shorter flight, after
// a duplicate share most of their span. Two truly distinct flights for one
// aircraft never overlap in time, so any substantial overlap means "same".
export const OVERLAP_THRESHOLD = 0.5;

// Parse a G3X "Lcl Date Lcl Time" string into epoch milliseconds, or null.
// Handles ISO (YYYY-MM-DD) and US (MM/DD/YYYY) date forms with `-` or `/`
// separators. Wall-clock values are treated as UTC: we only need a stable,
// comparable number, and two files of the same flight parse identically.
export function parseG3xTimestamp(str) {
  if (str == null) return null;
  const s = String(str).trim();
  if (!s) return null;

  const [datePart, timePart = ''] = s.split(/\s+/);
  const sep = datePart.includes('-') ? '-' : datePart.includes('/') ? '/' : null;
  if (!sep) return null;

  const dp = datePart.split(sep).map(Number);
  if (dp.length !== 3) return null;
  // Year-first (YYYY-MM-DD) vs month-first (MM/DD/YYYY)
  const [y, mo, d] = dp[0] > 31 ? dp : [dp[2], dp[0], dp[1]];

  const tp = timePart.split(':').map(Number);
  const hh = tp[0] || 0, mm = tp[1] || 0, ss = Math.floor(tp[2] || 0);

  if ([y, mo, d, hh, mm, ss].some(v => v == null || Number.isNaN(v))) return null;
  const ms = Date.UTC(y, mo - 1, d, hh, mm, ss);
  return Number.isNaN(ms) ? null : ms;
}

// Overlap of intervals [a0,a1] and [b0,b1] as a fraction of the shorter one.
// 1.0 = one fully contains the other; 0 = disjoint.
export function overlapFraction(a0, a1, b0, b1) {
  const aLo = Math.min(a0, a1), aHi = Math.max(a0, a1);
  const bLo = Math.min(b0, b1), bHi = Math.max(b0, b1);
  const inter = Math.min(aHi, bHi) - Math.max(aLo, bLo);
  if (inter <= 0) return 0;
  const shorter = Math.min(aHi - aLo, bHi - bLo);
  return shorter > 0 ? inter / shorter : 0;
}

// True when two flights' time ranges overlap enough to be the same flight.
// Returns false if either range is unknown (then content-hash dedupe applies).
export function timeRangesOverlap(a0, a1, b0, b1, threshold = OVERLAP_THRESHOLD) {
  if ([a0, a1, b0, b1].some(v => v == null)) return false;
  return overlapFraction(a0, a1, b0, b1) >= threshold;
}
