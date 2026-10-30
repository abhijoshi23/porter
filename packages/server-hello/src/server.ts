import {
  baseConfigSchema,
  defineTool,
  NotFoundError,
  paginate,
  paginationInput,
  type ServerDefinition,
} from '@abhijoshi23/porter-toolkit';
import * as z from 'zod/v4';

export const NAME = 'porter-hello';
export const VERSION = '0.0.0';

/** The hello server needs no settings beyond the shared ones. Real servers `.extend()` this. */
export const configSchema = baseConfigSchema;

// Static data keeps the example offline. Populations: 2021 Census of Population.
const CITIES = [
  { id: 'toronto', name: 'Toronto', region: 'Toronto', population: 2_794_356 },
  { id: 'mississauga', name: 'Mississauga', region: 'Peel', population: 717_961 },
  { id: 'hamilton', name: 'Hamilton', region: 'Hamilton', population: 569_353 },
  { id: 'brampton', name: 'Brampton', region: 'Peel', population: 656_480 },
  { id: 'kitchener', name: 'Kitchener', region: 'Waterloo', population: 256_885 },
  { id: 'waterloo', name: 'Waterloo', region: 'Waterloo', population: 121_436 },
  { id: 'cambridge', name: 'Cambridge', region: 'Waterloo', population: 138_479 },
  { id: 'guelph', name: 'Guelph', region: 'Wellington', population: 143_740 },
] as const;

const city = z.object({
  id: z.string().describe('Stable ID; pass to `get_city`.'),
  name: z.string(),
  region: z.string(),
  population: z.number().int().describe('2021 census population.'),
});

export const listCities = defineTool({
  name: 'list_cities',
  title: 'List Ontario cities',
  description:
    'List a few Ontario cities with their 2021 census population, optionally filtered by region ' +
    '(e.g. "Waterloo" returns Kitchener, Waterloo and Cambridge). Paginated: pass `nextCursor` back as `cursor`.',
  input: z.object({
    region: z.string().optional().describe('Exact region name, e.g. "Waterloo" or "Peel".'),
    ...paginationInput,
  }),
  output: z.object({
    cities: z.array(city),
    total: z.number().int(),
    nextCursor: z.string().optional(),
  }),
  handler: async ({ region, cursor, limit }) => {
    const matches = CITIES.filter(
      (c) => !region || c.region.toLowerCase() === region.toLowerCase(),
    );
    const page = paginate(matches, { cursor, limit });
    const more = page.nextCursor ? ' More results available; pass nextCursor.' : '';
    return {
      data: {
        cities: page.items,
        total: page.total,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      },
      summary: `Found ${page.total} cities${region ? ` in ${region}` : ''}; showing ${page.items.length}.${more}`,
    };
  },
});

export const getCity = defineTool({
  name: 'get_city',
  title: 'Get one city',
  description: 'Get one city by the `id` returned from `list_cities`.',
  input: z.object({ id: z.string().describe('City ID, e.g. "waterloo".') }),
  output: city,
  handler: async ({ id }) => {
    const found = CITIES.find((c) => c.id === id.toLowerCase());
    if (!found) {
      throw new NotFoundError(`No city with id "${id}".`, {
        hint: 'Call list_cities to get valid IDs.',
      });
    }
    return {
      data: found,
      summary: `${found.name} (${found.region} region) had ${found.population.toLocaleString('en-CA')} residents in 2021.`,
    };
  },
});

export const definition: ServerDefinition = {
  name: NAME,
  version: VERSION,
  title: 'Porter Hello',
  instructions:
    'Example server. Use list_cities to discover city IDs, then get_city for details. Data is static (2021 census).',
  tools: [listCities, getCity],
};
