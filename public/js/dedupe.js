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
