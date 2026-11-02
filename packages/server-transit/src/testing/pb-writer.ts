/**
 * Builds GTFS-RT protobuf bytes for tests: the mirror image of ../gtfs-rt.ts. Field numbers
 * as in gtfs-realtime.proto.
 */

type Field = [number, 'varint', number] | [number, 'bytes', Uint8Array | string];

function varint(n: number): number[] {
  const out: number[] = [];
  // Negative numbers are 10-byte two's complement, as protobuf encodes int32/int64.
  let v = BigInt.asUintN(64, BigInt(n));
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}

export function msg(...fields: (Field | null | undefined)[]): Uint8Array {
  const out: number[] = [];
  for (const f of fields) {
    if (!f) continue;
    const [num, kind, value] = f;
    if (kind === 'varint') {
      out.push(...varint(num * 8), ...varint(value));
    } else {
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
      out.push(...varint(num * 8 + 2), ...varint(bytes.length), ...bytes);
    }
  }
  return Uint8Array.from(out);
}

export interface TestTripUpdate {
  tripId: string;
  startDate?: string;
  canceled?: boolean;
  vehicle?: string;
  stops?: { seq?: number; stopId?: string; time?: number; delay?: number; skipped?: boolean }[];
}

export interface TestAlert {
  id: string;
  header: string;
  description: string;
  routeId?: string;
  stopId?: string;
  start?: number;
  end?: number;
  /** Effect enum: 4 = DETOUR */
  effect?: number;
}

export function feedMessage(o: {
  timestamp: number;
  trips?: TestTripUpdate[];
  alerts?: TestAlert[];
  /** An unknown extension field, to prove the decoder skips it. */
  withExtension?: boolean;
}): Uint8Array {
  const header = msg(
    [1, 'bytes', '2.0'],
    [3, 'varint', o.timestamp],
    o.withExtension ? [1000, 'bytes', 'x'] : null,
  );
  const entities = [
    ...(o.trips ?? []).map((t, i) => {
      const trip = msg(
        [1, 'bytes', t.tripId],
        t.startDate ? [3, 'bytes', t.startDate] : null,
        t.canceled ? [4, 'varint', 3] : null,
      );
      const stus = (t.stops ?? []).map((s) => {
        const ev = msg(
          s.delay !== undefined ? [1, 'varint', s.delay] : null,
          s.time !== undefined ? [2, 'varint', s.time] : null,
        );
        return [
          2,
          'bytes',
          msg(
            s.seq !== undefined ? [1, 'varint', s.seq] : null,
            [3, 'bytes', ev],
            s.stopId ? [4, 'bytes', s.stopId] : null,
            s.skipped ? [5, 'varint', 1] : null,
          ),
        ] as Field;
      });
      const tu = msg(
        [1, 'bytes', trip],
        ...stus,
        t.vehicle ? [3, 'bytes', msg([2, 'bytes', t.vehicle])] : null,
      );
      return msg([1, 'bytes', `tu${i}`], [3, 'bytes', tu]);
    }),
    ...(o.alerts ?? []).map((a) => {
      const text = (s: string) => msg([1, 'bytes', msg([1, 'bytes', s], [2, 'bytes', 'en'])]);
      const alert = msg(
        a.start !== undefined || a.end !== undefined
          ? [
              1,
              'bytes',
              msg(
                a.start !== undefined ? [1, 'varint', a.start] : null,
                a.end !== undefined ? [2, 'varint', a.end] : null,
              ),
            ]
          : null,
        [
          5,
          'bytes',
          msg(a.routeId ? [2, 'bytes', a.routeId] : null, a.stopId ? [5, 'bytes', a.stopId] : null),
        ],
        [7, 'varint', a.effect ?? 4],
        [10, 'bytes', text(a.header)],
        [11, 'bytes', text(a.description)],
      );
      return msg([1, 'bytes', a.id], [5, 'bytes', alert]);
    }),
  ];
  return msg([1, 'bytes', header], ...entities.map((e) => [2, 'bytes', e] as Field));
}
