import { describe, it, expect } from 'vitest';
import { cyrb53, fingerprintCsv } from '../public/js/dedupe.js';

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
