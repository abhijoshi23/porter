import { InvalidInputError, type HttpClient } from '@abhijoshi23/porter-toolkit';
import * as z from 'zod/v4';

export interface Licence {
  name: string;
  url: string;
  /** Exact wording the licence asks reusers to display, where it specifies one. */
  attribution?: string;
}

export interface Agency {
  id: AgencyId;
  name: string;
  region: string;
  /** Static GTFS zip, or a resolver for portals where the download URL can change. */
  staticUrl: string | ((http: HttpClient) => Promise<string>);
  /** GTFS-RT feeds. Omitted when none is openly available. */
  realtime?: { tripUpdates: string; alerts?: string };
  /** Shown when realtime is absent, so the model can explain why. */
  realtimeNote?: string;
  licence: Licence;
}

export const AGENCY_IDS = ['grt', 'hsr', 'ttc', 'go'] as const;
export type AgencyId = (typeof AGENCY_IDS)[number];

const TORONTO_CKAN = 'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action';
const ckanPackage = z.object({
  result: z.object({ resources: z.array(z.object({ url: z.string(), format: z.string() })) }),
});

/**
 * The four agencies, with endpoints verified on 2026-11-02 (docs/decisions-log.md).
 * None needs an API key, except GO realtime, which isn't included (see realtimeNote).
 */
export const AGENCIES: Record<AgencyId, Agency> = {
  grt: {
    id: 'grt',
    name: 'Grand River Transit',
    region: 'Waterloo Region (Kitchener, Waterloo, Cambridge), including ION light rail',
    staticUrl: 'https://webapps.regionofwaterloo.ca/api/grt-routes/api/staticfeeds/1',
    realtime: {
      tripUpdates: 'https://webapps.regionofwaterloo.ca/api/grt-routes/api/tripupdates',
      alerts: 'https://webapps.regionofwaterloo.ca/api/grt-routes/api/alerts',
    },
    licence: {
      name: 'Region of Waterloo Open Data Licence',
      url: 'https://www.regionofwaterloo.ca/en/regional-government/open-data.aspx',
    },
  },
  hsr: {
    id: 'hsr',
    name: 'Hamilton Street Railway',
    region: 'City of Hamilton',
    staticUrl: 'https://opendata.hamilton.ca/GTFS-Static/google_transit.zip',
    realtime: {
      tripUpdates: 'https://opendata.hamilton.ca/GTFS-RT/GTFS_TripUpdates.pb',
      alerts: 'https://opendata.hamilton.ca/GTFS-RT/GTFS_ServiceAlerts.pb',
    },
    licence: {
      name: 'City of Hamilton Open Data Licence',
      url: 'https://www.hamilton.ca/open-data-licence-terms-and-conditions',
      attribution:
        "Contains public sector Data made available under the City of Hamilton's Open Data Licence",
    },
  },
  ttc: {
    id: 'ttc',
    name: 'Toronto Transit Commission',
    region: 'City of Toronto: subway, streetcar and bus',
    // Published on Toronto's CKAN portal; resolve the current resource URL rather than
    // hard-coding a resource ID that a re-upload could change.
    staticUrl: async (http) => {
      const r = await http.getJson(
        `${TORONTO_CKAN}/package_show?id=merged-gtfs-ttc-routes-and-schedules`,
        ckanPackage,
      );
      const zip = r.result.resources.find((x) => /zip/i.test(x.format) || /\.zip$/i.test(x.url));
      if (!zip) throw new Error('TTC GTFS resource not found on the Toronto portal');
      return zip.url;
    },
    realtime: {
      tripUpdates: 'https://bustime.ttc.ca/gtfsrt/trips',
      alerts: 'https://bustime.ttc.ca/gtfsrt/alerts',
    },
    licence: {
      name: 'Open Government Licence – Toronto',
      url: 'https://open.toronto.ca/open-data-license/',
    },
  },
  go: {
    id: 'go',
    name: 'GO Transit',
    region: 'Greater Toronto and Hamilton Area regional trains and buses (Metrolinx)',
    staticUrl:
      'https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip',
    realtimeNote:
      'GO realtime requires a Metrolinx API key, so only scheduled times are available for GO.',
    licence: {
      name: 'GO Transit open data access and use agreement (Metrolinx)',
      url: 'https://www.gotransit.com/en/information-resources/software-developers',
    },
  },
};

/**
 * Names people (and models) actually use. Every model in the first eval run passed
 * "GO Transit" rather than "go", which cost a failed call each time.
 */
const ALIASES: Record<string, AgencyId> = {
  grandrivertransit: 'grt',
  grandriver: 'grt',
  ion: 'grt',
  regionofwaterloo: 'grt',
  hamiltonstreetrailway: 'hsr',
  hamiltontransit: 'hsr',
  torontotransitcommission: 'ttc',
  torontotransit: 'ttc',
  gotransit: 'go',
  metrolinx: 'go',
};

export function resolveAgencyId(input: string): AgencyId | undefined {
  const key = input.toLowerCase().replace(/[^a-z]/g, '');
  if ((AGENCY_IDS as readonly string[]).includes(key)) return key as AgencyId;
  return ALIASES[key] ?? ALIASES[key.replace(/transit$/, '')];
}

export function getAgency(id: string, enabled: readonly AgencyId[]): Agency {
  const resolved = resolveAgencyId(id);
  const a = resolved ? AGENCIES[resolved] : undefined;
  if (!a) {
    throw new InvalidInputError(`Unknown agency "${id}".`, {
      hint: `Use one of: ${enabled.join(', ')}. Call list_agencies for details.`,
    });
  }
  if (!enabled.includes(a.id)) {
    throw new InvalidInputError(`The ${a.name} feed is turned off on this server.`, {
      hint: `Enabled agencies: ${enabled.join(', ')} (PORTER_TRANSIT_AGENCIES).`,
    });
  }
  return a;
}
