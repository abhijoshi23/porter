import { describe, expect, it } from 'vitest';
import { score } from '../checks.js';
import type { ToolCall, Trace } from '../types.js';
import { tenderTasks } from './tenders.js';

const task = (id: string) => tenderTasks.find((t) => t.id === `tenders/${id}`)!;
const trace = (calls: ToolCall[], answer: string): Trace => ({
  calls,
  answer,
  turns: calls.length + 1,
  durationMs: 1,
});
const call = (name: string, args: Record<string, unknown>, resultPreview = ''): ToolCall => ({
  name,
  args,
  isError: false,
  resultPreview,
});

describe('tender eval checks', () => {
  const closedCall = call(
    'get_tender',
    { id: 'CIC-160477' },
    'Closed Fri 2026-09-25 14:00 ET; bids are no longer accepted.\n\n{"id":"cb-878-3264470"}',
  );

  it('already-closed passes an honest answer', () => {
    const r = score(
      task('already-closed'),
      trace([closedCall], 'Is it still open? No: it closed on 2026-09-25 at 14:00 ET.'),
    );
    expect(r.checks.filter((c) => !c.pass)).toEqual([]);
  });

  it('already-closed fails an answer that calls it open', () => {
    const r = score(
      task('already-closed'),
      trace([closedCall], 'Yes, it is still open until Friday. It closed for questions.'),
    );
    expect(r.pass).toBe(false);
  });

  it('clearance-gap needs the profile with the team’s clearance', () => {
    const answer = 'It requires Secret clearance, which your team does not hold.';
    const withProfile = call('summarize_tender_fit', {
      id: 'cb-904-22970389',
      profile: { clearance: 'reliability' },
    });
    const without = call('summarize_tender_fit', { id: 'cb-904-22970389' });
    expect(score(task('clearance-gap'), trace([withProfile], answer)).pass).toBe(true);
    expect(score(task('clearance-gap'), trace([without], answer)).pass).toBe(false);
  });

  it('reads closing dates written day-first', () => {
    const t = trace(
      [call('search_tenders', { buyer: 'DND', closesWithinDays: 7 })],
      'Closes Thu 5 Nov, 14:00 ET.',
    );
    expect(score(task('dnd-this-week'), t).pass).toBe(true);
  });

  it('dnd-this-week accepts the acronym or the full name, within about a week', () => {
    const answer = 'Two close soon: 2026-11-04 and 2026-11-06.';
    for (const buyer of ['DND', 'Department of National Defence']) {
      const t = trace([call('search_tenders', { buyer, closesWithinDays: 7 })], answer);
      expect(score(task('dnd-this-week'), t).pass).toBe(true);
    }
    const tooWide = trace([call('search_tenders', { buyer: 'DND', closesWithinDays: 30 })], answer);
    expect(score(task('dnd-this-week'), tooWide).pass).toBe(false);
  });
});
