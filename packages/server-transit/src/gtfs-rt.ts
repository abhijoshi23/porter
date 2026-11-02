import { PorterError } from '@abhijoshi23/porter-toolkit';

/**
 * A decoder for the parts of GTFS Realtime we use (TripUpdates and Alerts), written
 * against the protobuf wire format directly instead of pulling in protobufjs and the
 * generated bindings (~1 MB). Field numbers come from gtfs-realtime.proto
 * (https://gtfs.org/documentation/realtime/proto/).
 *
 * Protobuf wire format in brief: a message is a flat list of fields. Each field begins
 * with a varint key = (field_number << 3) | wire_type. The wire types are:
 *   0 varint      (int32, uint32, uint64, bool, enum): 7 bits per byte, low bits first,
 *                 high bit set on every byte but the last
 *   1 64-bit      fixed 8 bytes (double, fixed64)
 *   2 length-delimited  varint length, then that many bytes (string, bytes, sub-message)
 *   5 32-bit      fixed 4 bytes (float, fixed32)
 * A repeated field is the same key appearing several times. Unknown fields are skipped
 * by wire type, which is what keeps the format forward-compatible: feeds add extensions
 * (e.g. TTC, field 1000+) and we just step over them.
 *
 * Negative int32 values (a train running 2 minutes early has delay = -120) are encoded as
 * 10-byte two's-complement varints, hence the BigInt path in `varint()`.
 */

class Reader {
  pos: number;
  constructor(
    readonly buf: Uint8Array,
    start = 0,
    readonly end = buf.length,
  ) {
    this.pos = start;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  varint(): number {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw malformed('truncated varint');
      const b = this.buf[this.pos++]!;
      if (i < 7) {
        // Up to 49 bits: exact in a double.
        result += (b & 0x7f) * 2 ** shift;
      } else {
        return this.bigVarint(i);
      }
      shift += 7;
      if ((b & 0x80) === 0) return result;
    }
    throw malformed('varint too long');
  }

  /** Re-reads a long varint as BigInt and narrows it to a signed 64-bit number. */
  private bigVarint(bytesSoFar: number): number {
    this.pos -= bytesSoFar + 1;
    let v = 0n;
    for (let i = 0; i < 10; i++) {
      const b = this.buf[this.pos++]!;
      v |= BigInt(b & 0x7f) << BigInt(7 * i);
      if ((b & 0x80) === 0) return Number(BigInt.asIntN(64, v));
      if (this.pos >= this.end) throw malformed('truncated varint');
    }
    throw malformed('varint too long');
  }

  /** Returns [fieldNumber, wireType]. */
  key(): [number, number] {
    const k = this.varint();
    return [Math.floor(k / 8), k & 7];
  }

  bytes(): Reader {
    const len = this.varint();
    const start = this.pos;
    if (start + len > this.end) throw malformed('length past end of message');
    this.pos += len;
    return new Reader(this.buf, start, start + len);
  }

  string(): string {
    const r = this.bytes();
    return new TextDecoder().decode(this.buf.subarray(r.pos, r.end));
  }

  skip(wireType: number): void {
    switch (wireType) {
      case 0:
        this.varint();
        return;
      case 1:
        this.pos += 8;
        break;
      case 2:
        this.bytes();
        return;
      case 5:
        this.pos += 4;
        break;
      default:
        // 3/4 are the long-deprecated proto2 groups; nothing in GTFS-RT uses them.
        throw malformed(`unsupported wire type ${wireType}`);
    }
    if (this.pos > this.end) throw malformed('field past end of message');
  }
}

function malformed(detail: string): PorterError {
  return new PorterError(`The realtime feed could not be decoded (${detail}).`, {
    hint: 'Realtime data is unavailable right now; scheduled times are still valid.',
    retryable: true,
  });
}

/** Iterates fields of a message, calling `on` for each; skips anything `on` doesn't consume. */
function fields(r: Reader, on: (field: number, wire: number, r: Reader) => boolean): void {
  while (!r.done) {
    const [field, wire] = r.key();
    if (!on(field, wire, r)) r.skip(wire);
  }
}

export interface StopTimeEvent {
  /** Seconds late (negative = early). */
  delay?: number;
  /** Predicted time, epoch seconds. */
  time?: number;
}

export interface StopTimeUpdate {
  stopSequence?: number;
  stopId?: string;
  arrival?: StopTimeEvent;
  departure?: StopTimeEvent;
  /** 0 SCHEDULED, 1 SKIPPED, 2 NO_DATA, 3 UNSCHEDULED */
  scheduleRelationship: number;
}

export interface TripUpdate {
  tripId?: string;
  routeId?: string;
  /** `YYYYMMDD` service day this run belongs to (a trip_id repeats daily). */
  startDate?: string;
  /** 0 SCHEDULED, 1 ADDED, 2 UNSCHEDULED, 3 CANCELED, 5 REPLACEMENT, 6 DUPLICATED, 7 DELETED */
  scheduleRelationship: number;
  vehicleLabel?: string;
  delay?: number;
  stopTimeUpdates: StopTimeUpdate[];
}

export interface Alert {
  id: string;
  activePeriods: { start?: number; end?: number }[];
  informed: { routeId?: string; stopId?: string; tripId?: string; routeType?: number }[];
  cause: string;
  effect: string;
  header?: string;
  description?: string;
  url?: string;
}

export interface FeedMessage {
  /** Epoch seconds when the producer generated the feed. */
  timestamp?: number;
  tripUpdates: TripUpdate[];
  alerts: Alert[];
}

const CAUSES = [
  '',
  'UNKNOWN_CAUSE',
  'OTHER_CAUSE',
  'TECHNICAL_PROBLEM',
  'STRIKE',
  'DEMONSTRATION',
  'ACCIDENT',
  'HOLIDAY',
  'WEATHER',
  'MAINTENANCE',
  'CONSTRUCTION',
  'POLICE_ACTIVITY',
  'MEDICAL_EMERGENCY',
];
const EFFECTS = [
  '',
  'NO_SERVICE',
  'REDUCED_SERVICE',
  'SIGNIFICANT_DELAYS',
  'DETOUR',
  'ADDITIONAL_SERVICE',
  'MODIFIED_SERVICE',
  'OTHER_EFFECT',
  'UNKNOWN_EFFECT',
  'STOP_MOVED',
  'NO_EFFECT',
  'ACCESSIBILITY_ISSUE',
];

/** Decodes a GTFS-RT FeedMessage. Throws PorterError on malformed input, never hangs. */
export function decodeFeed(buf: Uint8Array): FeedMessage {
  const feed: FeedMessage = { tripUpdates: [], alerts: [] };
  fields(new Reader(buf), (f, w, r) => {
    if (f === 1 && w === 2) {
      // FeedHeader
      fields(r.bytes(), (hf, hw, hr) => {
        if (hf === 3 && hw === 0) feed.timestamp = hr.varint();
        return hf === 3 && hw === 0;
      });
      return true;
    }
    if (f === 2 && w === 2) {
      decodeEntity(r.bytes(), feed);
      return true;
    }
    return false;
  });
  return feed;
}

function decodeEntity(r: Reader, feed: FeedMessage): void {
  let id = '';
  let deleted = false;
  let tu: TripUpdate | undefined;
  let alert: Alert | undefined;
  fields(r, (f, w, er) => {
    if (f === 1 && w === 2) id = er.string();
    else if (f === 2 && w === 0) deleted = er.varint() !== 0;
    else if (f === 3 && w === 2) tu = decodeTripUpdate(er.bytes());
    else if (f === 5 && w === 2) alert = decodeAlert(er.bytes(), id);
    else return false;
    return true;
  });
  if (deleted) return;
  if (tu) feed.tripUpdates.push(tu);
  if (alert) feed.alerts.push({ ...alert, id });
}

function decodeTripUpdate(r: Reader): TripUpdate {
  const tu: TripUpdate = { scheduleRelationship: 0, stopTimeUpdates: [] };
  fields(r, (f, w, tr) => {
    if (f === 1 && w === 2) {
      // TripDescriptor
      fields(tr.bytes(), (df, dw, dr) => {
        if (df === 1 && dw === 2) tu.tripId = dr.string();
        else if (df === 3 && dw === 2) tu.startDate = dr.string();
        else if (df === 4 && dw === 0) tu.scheduleRelationship = dr.varint();
        else if (df === 5 && dw === 2) tu.routeId = dr.string();
        else return false;
        return true;
      });
    } else if (f === 2 && w === 2) {
      tu.stopTimeUpdates.push(decodeStopTimeUpdate(tr.bytes()));
    } else if (f === 3 && w === 2) {
      // VehicleDescriptor: 2 = label (what's on the bus or train)
      fields(tr.bytes(), (vf, vw, vr) => {
        if (vf === 2 && vw === 2) tu.vehicleLabel = vr.string();
        return vf === 2 && vw === 2;
      });
    } else if (f === 5 && w === 0) {
      tu.delay = tr.varint();
    } else return false;
    return true;
  });
  return tu;
}

function decodeStopTimeUpdate(r: Reader): StopTimeUpdate {
  const u: StopTimeUpdate = { scheduleRelationship: 0 };
  fields(r, (f, w, sr) => {
    if (f === 1 && w === 0) u.stopSequence = sr.varint();
    else if (f === 2 && w === 2) u.arrival = decodeEvent(sr.bytes());
    else if (f === 3 && w === 2) u.departure = decodeEvent(sr.bytes());
    else if (f === 4 && w === 2) u.stopId = sr.string();
    else if (f === 5 && w === 0) u.scheduleRelationship = sr.varint();
    else return false;
    return true;
  });
  return u;
}

function decodeEvent(r: Reader): StopTimeEvent {
  const e: StopTimeEvent = {};
  fields(r, (f, w, er) => {
    if (w !== 0) return false;
    // delay is int32 but encoded as a 64-bit varint when negative; `varint()` handles both.
    if (f === 1) e.delay = er.varint();
    else if (f === 2) e.time = er.varint();
    else return false;
    return true;
  });
  return e;
}

function decodeAlert(r: Reader, id: string): Alert {
  const a: Alert = {
    id,
    activePeriods: [],
    informed: [],
    cause: 'UNKNOWN_CAUSE',
    effect: 'UNKNOWN_EFFECT',
  };
  fields(r, (f, w, ar) => {
    if (f === 1 && w === 2) {
      const p: { start?: number; end?: number } = {};
      fields(ar.bytes(), (pf, pw, pr) => {
        if (pw !== 0) return false;
        if (pf === 1) p.start = pr.varint();
        else if (pf === 2) p.end = pr.varint();
        else return false;
        return true;
      });
      a.activePeriods.push(p);
    } else if (f === 5 && w === 2) {
      const e: Alert['informed'][number] = {};
      fields(ar.bytes(), (ef, ew, xr) => {
        if (ef === 2 && ew === 2) e.routeId = xr.string();
        else if (ef === 3 && ew === 0) e.routeType = xr.varint();
        else if (ef === 5 && ew === 2) e.stopId = xr.string();
        else if (ef === 4 && ew === 2) {
          fields(xr.bytes(), (tf, tw, tr) => {
            if (tf === 1 && tw === 2) e.tripId = tr.string();
            return tf === 1 && tw === 2;
          });
        } else return false;
        return true;
      });
      a.informed.push(e);
    } else if (f === 6 && w === 0) a.cause = CAUSES[ar.varint()] ?? 'UNKNOWN_CAUSE';
    else if (f === 7 && w === 0) a.effect = EFFECTS[ar.varint()] ?? 'UNKNOWN_EFFECT';
    else if (f === 8 && w === 2) a.url = translated(ar.bytes());
    else if (f === 10 && w === 2) a.header = translated(ar.bytes());
    else if (f === 11 && w === 2) a.description = translated(ar.bytes());
    else return false;
    return true;
  });
  return a;
}

/** TranslatedString: prefer English, else untagged, else the first translation. */
function translated(r: Reader): string | undefined {
  const all: { text: string; lang?: string }[] = [];
  fields(r, (f, w, tr) => {
    if (f !== 1 || w !== 2) return false;
    const t: { text: string; lang?: string } = { text: '' };
    fields(tr.bytes(), (xf, xw, xr) => {
      if (xf === 1 && xw === 2) t.text = xr.string();
      else if (xf === 2 && xw === 2) t.lang = xr.string();
      else return false;
      return true;
    });
    all.push(t);
    return true;
  });
  return (
    all.find((t) => t.lang?.toLowerCase().startsWith('en')) ??
    all.find((t) => !t.lang) ??
    all[0]
  )?.text;
}
