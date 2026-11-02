import { makeZip } from './zip-writer.js';

/**
 * A small synthetic GTFS feed ("Testville") that packs in every real-world quirk found in
 * the Ontario feeds, so tests are fast and deterministic. Served in tests as GRT's static
 * feed. Reference date: Monday 2026-11-02 (America/Toronto), the day after DST ended.
 *
 *   Stops                         Quirk
 *   S1 "Main / King"              } same corner written two ways (HSR "KING at JAMES")
 *   S2 "King at Main"             }
 *   S3 Central Station            station (location_type 1) with platforms S3A, S3B and an entrance
 *   S4 "University Ave at Erb St"
 *   S5 "Erb St at Albert St"
 *   S6 "Elm St", S7 "Elm Street"  same name and same code 2000, 5 km apart: really ambiguous
 *
 *   Trips (service)
 *   T1 route 1, WKDY  S1 08:05 → S3A 08:15 → S4 08:25
 *   T2 route 1, WKDY  S2 08:20 → S3A 08:30 → S4 08:40        (cancelled in the realtime fixture)
 *   T3 route 1, WKND  S1 08:10 → S3A 08:20 → S4 08:30
 *   T4 route 200, XTRA (added by calendar_dates on 2026-11-02 only)  S3B 08:12 → S4 08:22
 *   T5 route 200, WKDY  S3B 09:00 → S4 09:10                   (WKDY removed on 2026-11-11)
 *   T6 route ION, WKDY  S4 23:50 → S3A 24:40 → S5 25:10        (runs past midnight)
 *   T7 route 1, WKDY  S4 " 7:05:00" → S1 " 7:15:00"           (HSR-style padded times)
 *   T8 route 1, WKDY  loop S1 09:00 → S4 09:10 → S1 09:20
 *   T9 route 1, WKDY  S1 08:07 drop-off only → S4 08:17
 *
 * stops.txt starts with a UTF-8 BOM (GO) and trips.txt puts trip_id first (TTC).
 */
export const TESTVILLE: Record<string, string> = {
  'agency.txt':
    'agency_id,agency_name,agency_url,agency_timezone\nTV,Testville Transit,https://example.org,America/Toronto\n',
  'stops.txt':
    '\ufeffstop_id,stop_code,stop_name,stop_lat,stop_lon,location_type,parent_station\n' +
    'S1,1001,Main / King,43.4500,-80.4900,0,\n' +
    'S2,1002,King at Main,43.4502,-80.4903,0,\n' +
    'S3,,Central Station,43.4600,-80.5000,1,\n' +
    'S3A,3001,Central Station Platform 1,43.4600,-80.5001,0,S3\n' +
    'S3B,3002,Central Station Platform 2,43.4601,-80.5001,0,S3\n' +
    'E3,,Central Station Entrance,43.4602,-80.5002,2,S3\n' +
    'S4,1004,University Ave at Erb St,43.4700,-80.5200,0,\n' +
    'S5,1005,Erb St at Albert St,43.4710,-80.5300,0,\n' +
    'S6,2000,Elm St,43.4000,-80.4000,0,\n' +
    'S7,2000,Elm Street,43.4450,-80.4000,0,\n',
  'routes.txt':
    'route_id,agency_id,route_short_name,route_long_name,route_type\n' +
    'R1,TV,1,Main,3\nR2,TV,200,Express,3\nR3,TV,ION,ION Light Rail,0\n',
  'trips.txt':
    'trip_id,route_id,service_id,trip_headsign,direction_id\n' +
    'T1,R1,WKDY,Downtown,0\nT2,R1,WKDY,Downtown,0\nT3,R1,WKND,Downtown,0\n' +
    'T4,R2,XTRA,University,0\nT5,R2,WKDY,University,0\nT6,R3,WKDY,Albert,0\n' +
    'T7,R1,WKDY,Uptown,1\nT8,R1,WKDY,Loop,0\nT9,R1,WKDY,University,0\n',
  'stop_times.txt':
    'trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\n' +
    'T1,08:05:00,08:05:00,S1,1,0,0\nT1,08:15:00,08:15:00,S3A,2,0,0\nT1,08:25:00,08:25:00,S4,3,0,0\n' +
    'T2,08:20:00,08:20:00,S2,1,0,0\nT2,08:30:00,08:30:00,S3A,2,0,0\nT2,08:40:00,08:40:00,S4,3,0,0\n' +
    'T3,08:10:00,08:10:00,S1,1,0,0\nT3,08:20:00,08:20:00,S3A,2,0,0\nT3,08:30:00,08:30:00,S4,3,0,0\n' +
    'T4,08:12:00,08:12:00,S3B,1,0,0\nT4,08:22:00,08:22:00,S4,2,0,0\n' +
    'T5,09:00:00,09:00:00,S3B,1,0,0\nT5,09:10:00,09:10:00,S4,2,0,0\n' +
    'T6,23:50:00,23:50:00,S4,1,0,0\nT6,24:40:00,24:40:00,S3A,2,0,0\nT6,25:10:00,25:10:00,S5,3,0,0\n' +
    'T7, 7:05:00, 7:05:00,S4,1,0,0\nT7, 7:15:00, 7:15:00,S1,2,0,0\n' +
    'T8,09:00:00,09:00:00,S1,1,0,0\nT8,09:10:00,09:10:00,S4,2,0,0\nT8,09:20:00,09:20:00,S1,3,0,0\n' +
    'T9,08:07:00,08:07:00,S1,1,1,0\nT9,08:17:00,08:17:00,S4,2,0,0\n',
  'calendar.txt':
    'service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\n' +
    'WKDY,1,1,1,1,1,0,0,20261001,20261231\nWKND,0,0,0,0,0,1,1,20261001,20261231\n',
  'calendar_dates.txt': 'service_id,date,exception_type\nXTRA,20261102,1\nWKDY,20261111,2\n',
  'feed_info.txt':
    'feed_publisher_name,feed_publisher_url,feed_lang,feed_version\nTestville,https://example.org,en,TV-2026-11\n',
};

/** A GO-like feed: calendar_dates.txt only, BOM on every header, files in a subfolder. */
export const CALENDAR_DATES_ONLY: Record<string, string> = {
  'agency.txt':
    '\ufeffagency_id,agency_name,agency_url,agency_timezone\nGO,GO Test,https://example.org,America/Toronto\n',
  'stops.txt':
    '\ufeffstop_id,stop_name,stop_lat,stop_lon\nUN,Union Station GO,43.645,-79.380\nKI,Kitchener GO,43.455,-80.493\n',
  'routes.txt':
    '\ufeffroute_id,agency_id,route_short_name,route_long_name,route_type\nKI,GO,KI,Kitchener,2\n',
  'trips.txt': '\ufeffroute_id,service_id,trip_id,trip_headsign\nKI,20261102,K1,Union Station GO\n',
  'stop_times.txt':
    '\ufefftrip_id,arrival_time,departure_time,stop_id,stop_sequence\nK1,06:07:00,06:07:00,KI,1\nK1,07:47:00,07:47:00,UN,2\n',
  'calendar_dates.txt': '\ufeffservice_id,date,exception_type\n20261102,20261102,1\n',
};

export function feedZip(files: Record<string, string>, folder = ''): Buffer {
  return makeZip(Object.entries(files).map(([name, data]) => ({ name: folder + name, data })));
}
