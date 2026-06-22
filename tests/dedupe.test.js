import { describe, it, expect } from 'vitest';
import {
  cyrb53, fingerprintCsv,
  parseG3xTimestamp, overlapFraction, timeRangesOverlap,
} from '../public/js/dedupe.js';

describe('cyrb53', () => {
  it('is deterministic for the same input', () => {
    expect(cyrb53('hello world')).toBe(cyrb53('hello world'));
  });

  it('returns different hashes for different input', () => {
    expect(cyrb53('flight-a')).not.toBe(cyrb53('flight-b'));
  });

  it('returns a non-empty string', () => {
    const h = cyrb53('x');
    expect(typeof h).toBe('string');
    expect(h.length).toBeGreaterThan(0);
  });
});

describe('fingerprintCsv', () => {
  it('ignores CRLF vs LF and trailing whitespace', () => {
    expect(fingerprintCsv('a,b\n1,2')).toBe(fingerprintCsv('a,b\r\n1,2\n'));
    expect(fingerprintCsv('a,b\n1,2')).toBe(fingerprintCsv('  a,b\n1,2\n\n'));
  });

  it('distinguishes flights that differ in their data', () => {
    expect(fingerprintCsv('a,b\n1,2')).not.toBe(fingerprintCsv('a,b\n1,3'));
  });

  it('treats an identical re-upload as the same flight', () => {
    const csv = 'Lcl Date,Lcl Time,AltP\n2024-01-01,12:00:00,8000';
    expect(fingerprintCsv(csv)).toBe(fingerprintCsv(csv));
  });
});

describe('parseG3xTimestamp', () => {
  it('parses ISO date + time', () => {
    expect(parseG3xTimestamp('2026-01-01 12:00:00')).toBe(Date.UTC(2026, 0, 1, 12, 0, 0));
  });

  it('parses US (MM/DD/YYYY) date + time', () => {
    expect(parseG3xTimestamp('01/02/2026 06:30:15')).toBe(Date.UTC(2026, 0, 2, 6, 30, 15));
  });

  it('orders chronologically', () => {
    expect(parseG3xTimestamp('2026-01-01 12:00:00'))
      .toBeLessThan(parseG3xTimestamp('2026-01-01 12:00:01'));
  });

  it('returns null for missing or unparseable input', () => {
    expect(parseG3xTimestamp('')).toBeNull();
    expect(parseG3xTimestamp(null)).toBeNull();
    expect(parseG3xTimestamp(undefined)).toBeNull();
    expect(parseG3xTimestamp('not a date')).toBeNull();
  });
});

describe('overlapFraction', () => {
  it('is 1.0 when one interval contains the other', () => {
    expect(overlapFraction(0, 100, 10, 40)).toBe(1); // [10,40] inside [0,100]
  });

  it('is 0 for disjoint intervals', () => {
    expect(overlapFraction(0, 100, 200, 300)).toBe(0);
  });

  it('measures overlap relative to the shorter interval', () => {
    // overlap [50,100] = 50; shorter interval = 100 → 0.5
    expect(overlapFraction(0, 100, 50, 150)).toBeCloseTo(0.5, 5);
  });
});

describe('timeRangesOverlap — same flight, two SD cards', () => {
  const t = (h, m, s) => Date.UTC(2026, 0, 1, h, m, s);

  it('treats slightly offset recordings of one flight as overlapping', () => {
    // Card A: 13:00:05–14:30:10, Card B: 13:00:12–14:30:03 (a few seconds off)
    expect(timeRangesOverlap(t(13, 0, 5), t(14, 30, 10), t(13, 0, 12), t(14, 30, 3))).toBe(true);
  });

  it('does not merge two distinct flights on the same day', () => {
    // Morning flight vs afternoon flight — no time overlap
    expect(timeRangesOverlap(t(8, 0, 0), t(9, 30, 0), t(13, 0, 0), t(14, 30, 0))).toBe(false);
  });

  it('returns false when either range is unknown', () => {
    expect(timeRangesOverlap(null, null, t(13, 0, 0), t(14, 0, 0))).toBe(false);
    expect(timeRangesOverlap(t(13, 0, 0), t(14, 0, 0), null, null)).toBe(false);
  });
});
