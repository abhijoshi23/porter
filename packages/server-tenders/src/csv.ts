import { InvalidInputError } from '@abhijoshi23/porter-toolkit';

/**
 * RFC 4180 CSV parser. CanadaBuys descriptions span many lines inside quoted fields and
 * escape quotes by doubling them (`""`), so a line-by-line split would be wrong.
 *
 * One pass, one state machine, no regexes: linear in the input, so a hostile file can't
 * make it backtrack. A leading UTF-8 BOM (CanadaBuys files start with one) is dropped.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += c;
      }
      i++;
      continue;
    }
    if (c === '"' && field === '') quoted = true;
    else if (c === ',') endField();
    else if (c === '\n') endRow();
    else if (c === '\r') {
      if (text[i + 1] !== '\n') endRow();
    } else field += c;
    i++;
  }
  if (quoted) {
    throw new InvalidInputError('The CSV file ends inside a quoted field.', {
      hint: 'The publisher may have posted an incomplete file. Try again later.',
      retryable: true,
    });
  }
  if (field !== '' || row.length) endRow();
  return rows;
}

/** Rows as objects keyed by the header row. Missing trailing cells read as ''. */
export function csvRecords(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  return rows
    .filter((r) => !(r.length === 1 && r[0] === ''))
    .map((r) => Object.fromEntries(header.map((h, j) => [h, r[j] ?? ''])));
}
