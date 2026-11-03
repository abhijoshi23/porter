import { normalize } from './search.js';

/**
 * CanadaBuys region values mix provinces ("Ontario (except NCR)"), the National Capital
 * Region, and cities ("Petawawa", "Montréal"). A user asking for "Ontario" means all of
 * these, Ottawa included. Each entry lists the strings that count as that place; the city
 * lists cover the cities that actually appear in the data.
 */
const PLACES: { names: string[]; match: string[] }[] = [
  {
    names: ['ontario', 'on', 'ont'],
    match: [
      'ontario',
      'national capital region',
      'ottawa',
      'toronto',
      'kingston',
      'petawawa',
      'barrie',
      'london',
      'gravenhurst',
      'hamilton',
      'kitchener',
      'waterloo',
      'sudbury',
      'thunder bay',
      'windsor',
      'borden',
      'trenton',
      'north bay',
    ],
  },
  {
    names: ['quebec', 'qc', 'que'],
    match: [
      'quebec',
      'national capital region',
      'gatineau',
      'montreal',
      'longueuil',
      'saint-jean-sur-richelieu',
      'saint-hyacinthe',
      'saguenay',
      'valcartier',
      'sherbrooke',
      'bagotville',
    ],
  },
  {
    names: ['ncr', 'national capital region', 'ottawa', 'gatineau', 'ottawa-gatineau'],
    match: ['national capital region', 'ottawa', 'gatineau'],
  },
  {
    names: ['british columbia', 'bc'],
    match: ['british columbia', 'victoria', 'vancouver', 'esquimalt', 'comox', 'nanaimo'],
  },
  {
    names: ['alberta', 'ab', 'alta'],
    match: ['alberta', 'edmonton', 'calgary', 'wainwright', 'cold lake'],
  },
  {
    names: ['saskatchewan', 'sk', 'sask'],
    match: ['saskatchewan', 'saskatoon', 'regina', 'prince albert'],
  },
  { names: ['manitoba', 'mb', 'man'], match: ['manitoba', 'winnipeg', 'brandon', 'shilo'] },
  { names: ['nova scotia', 'ns'], match: ['nova scotia', 'halifax', 'dartmouth', 'greenwood'] },
  {
    names: ['new brunswick', 'nb'],
    match: ['new brunswick', 'oromocto', 'gagetown', 'fredericton', 'moncton'],
  },
  {
    names: ['newfoundland and labrador', 'newfoundland', 'labrador', 'nl', 'nfld'],
    match: ['newfoundland', 'labrador', "st. john's", 'goose bay'],
  },
  {
    names: ['prince edward island', 'pei', 'pe'],
    match: ['prince edward island', 'charlottetown'],
  },
  { names: ['yukon', 'yt'], match: ['yukon', 'whitehorse'] },
  {
    names: ['northwest territories', 'nwt', 'nt'],
    match: ['northwest territories', 'yellowknife', 'inuvik'],
  },
  { names: ['nunavut', 'nu'], match: ['nunavut', 'iqaluit'] },
];

export interface RegionMatcher {
  /** What the input was read as, for the result's `interpretation`. */
  label: string;
  /** True when a notice's delivery or opportunity regions include this place. */
  local: (regions: string[]) => boolean;
}

export function regionMatcher(input: string): RegionMatcher {
  const q = normalize(input.trim()).replace(/\./g, '');
  const place = PLACES.find((p) => p.names.includes(q));
  const needles = place ? place.match : [q];
  return {
    label: place ? place.names[0]! : input.trim(),
    local: (regions) => regions.some((r) => needles.some((n) => normalize(r).includes(n))),
  };
}

/** Delivery anywhere in Canada (or unrestricted): relevant to a supplier in any region. */
export function isNational(regions: string[]): boolean {
  return regions.some((r) => r === 'Canada');
}
