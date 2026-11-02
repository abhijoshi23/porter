import { answer, anyOf, called, defineTask, maxCalls } from '../checks.js';

/**
 * Transit tasks run against live feeds, so checks test behaviour (right agency and tool,
 * a clock time in the answer, honesty about live vs scheduled), not exact departures.
 */
const CLOCK = /\b([01]?\d|2[0-3]):[0-5]\d\b|\b\d{1,2}(:\d{2})?\s?[ap]\.?m\b/i;

export const transitTasks = [
  defineTask({
    id: 'transit/go-kitchener-union',
    servers: ['transit'],
    intent: 'GO trip; must say times are scheduled (GO has no open realtime)',
    prompt: "When's the next GO train from Kitchener to Union Station?",
    checks: [
      anyOf(
        'asked GO for a trip or departures',
        called('plan_simple_trip', { agency: 'go' }),
        called('next_departures', { agency: 'go' }),
      ),
      answer(CLOCK, 'answer gives a time'),
      answer(
        /schedul|timetable|not (real-?time|live)|no (real-?time|live)/i,
        'answer says the time is scheduled',
      ),
      maxCalls(6),
    ],
  }),
  defineTask({
    id: 'transit/hsr-king-james',
    servers: ['transit'],
    intent: 'Intersection named two ways in the data (KING at JAMES / JAMES at KING)',
    prompt: 'When are the next buses at King and James in Hamilton?',
    checks: [
      called('next_departures', { agency: 'hsr' }),
      answer(CLOCK, 'answer gives times'),
      maxCalls(4),
    ],
  }),
  defineTask({
    id: 'transit/ttc-finch-union',
    servers: ['transit'],
    intent: 'Direct subway trip: ride time',
    prompt: 'How long does the subway take from Finch to Union station in Toronto?',
    checks: [
      called('plan_simple_trip', { agency: 'ttc' }),
      answer(/\b\d{1,3}\s?(min|minutes)\b/i, 'answer gives a duration'),
      maxCalls(5),
    ],
  }),
  defineTask({
    id: 'transit/ttc-504-last',
    servers: ['transit'],
    intent: 'Span of service with after-midnight times',
    prompt: 'When does the last 504 King streetcar run tonight?',
    checks: [
      called('route_info', { agency: 'ttc', route: /504/ }),
      answer(CLOCK, 'answer gives a time'),
      maxCalls(4),
    ],
  }),
  defineTask({
    id: 'transit/hsr-detours',
    servers: ['transit'],
    intent: 'Service alerts for one route',
    prompt: 'Are there any detours on HSR route 1 right now?',
    checks: [called('service_alerts', { agency: 'hsr' }), maxCalls(3)],
  }),
  defineTask({
    id: 'transit/grt-stops-near',
    servers: ['transit'],
    intent: 'Location search with coordinates',
    prompt: 'Which Grand River Transit stops are near 43.4643, -80.5204?',
    checks: [
      called('find_stops', { agency: 'grt' }),
      answer(/Public Square|King/i, 'answer names nearby stops'),
      maxCalls(3),
    ],
  }),
  defineTask({
    id: 'transit/grt-live-honesty',
    servers: ['transit'],
    intent: 'Asked about delays when the live feed is stale: must not invent live data',
    prompt: 'Is the next bus at Waterloo Public Square running late?',
    checks: [
      called('next_departures', { agency: 'grt' }),
      answer(
        /schedul|stale|no (live|real-?time)|not (available|live|real-?time)|out of date|outdated|isn't (live|current)/i,
        'answer is honest about live data',
      ),
    ],
  }),
  defineTask({
    id: 'transit/go-union-ambiguous',
    servers: ['transit'],
    intent: 'Two "Union Station" stops on GO (train vs bus terminal)',
    prompt: 'Show me the next GO train departures from Union Station.',
    checks: [
      anyOf(
        'got departures from the train station, or asked which',
        called('next_departures', { agency: 'go' }, { result: /Union Station GO\b(?! Bus)/ }),
        answer(/which (one|station)|bus terminal or|did you mean/i),
      ),
    ],
  }),
];
