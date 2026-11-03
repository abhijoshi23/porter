import { describe, expect, it } from 'vitest';
import { csvRecords, parseCsv } from './csv.js';

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, embedded newlines and commas', () => {
    expect(parseCsv('a,b,c\n"x, y","say ""hi""","line1\nline2"\n')).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2'],
    ]);
  });

  it('accepts CRLF, a BOM, empty fields and no final newline', () => {
    expect(parseCsv('\uFEFFa,b\r\n,2\r\n3,')).toEqual([
      ['a', 'b'],
      ['', '2'],
      ['3', ''],
    ]);
  });

  it('keeps a quote that appears mid-field as text', () => {
    expect(parseCsv('a 5" pipe,b')).toEqual([['a 5" pipe', 'b']]);
  });

  it('rejects a file cut off inside a quoted field', () => {
    expect(() => parseCsv('a,"unterminated')).toThrow(/ends inside a quoted field/);
  });

  it('is linear on hostile input', () => {
    const t = performance.now();
    parseCsv(`"${'""'.repeat(500_000)}"`);
    parseCsv(','.repeat(1_000_000));
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe('csvRecords', () => {
  it('maps rows to the header and pads short rows', () => {
    expect(csvRecords('a,b\n1\n2,3\n')).toEqual([
      { a: '1', b: '' },
      { a: '2', b: '3' },
    ]);
  });
});
