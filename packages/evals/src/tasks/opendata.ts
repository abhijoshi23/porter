import { answer, anyOf, before, called, defineTask, maxCalls, notCalled } from '../checks.js';

/**
 * Open-data tasks. Values asserted here were checked against live data on 2026-11-02:
 * City of Waterloo 2021 population 121,436 (table 98-10-0002-01); Toronto Public Library
 * has 112 branch records, 100 of them physical branches.
 */
export const opendataTasks = [
  defineTask({
    id: 'opendata/kcw-unemployment',
    servers: ['opendata'],
    intent: 'Chain find_table → get_series for a CMA, with citation',
    prompt: 'How has the unemployment rate in Kitchener-Cambridge-Waterloo changed since 2019?',
    checks: [
      called('statcan_get_series', { geography: /kitchener/i }),
      answer(/\d+(\.\d)?\s?%/, 'answer gives a rate'),
      answer(/10\.25318|\d{2}-\d{2}-\d{4}-\d{2}|Statistics Canada/i, 'answer cites StatCan'),
      maxCalls(8),
    ],
  }),
  defineTask({
    id: 'opendata/waterloo-city-population',
    servers: ['opendata'],
    intent: 'Census table, look-alike geographies resolved to the city',
    prompt: 'What was the population of the City of Waterloo, Ontario, in the 2021 Census?',
    checks: [
      called('statcan_get_series'),
      answer(/121[,\s.]?436/, 'answer is 121,436'),
      maxCalls(10),
    ],
  }),
  defineTask({
    id: 'opendata/waterloo-ambiguous',
    servers: ['opendata'],
    intent: 'An ambiguous place: picks explicitly or asks, never silently guesses',
    prompt: "What's the population of Waterloo?",
    checks: [
      answer(
        /\b(city|region|regional|census metropolitan|CMA|which Waterloo|Quebec|Kitchener-Cambridge-Waterloo)\b/i,
        'answer says which Waterloo, or asks',
      ),
    ],
  }),
  defineTask({
    id: 'opendata/toronto-libraries',
    servers: ['opendata'],
    intent: 'Dataset path: search → get → query a CSV, with licence',
    prompt:
      'Using the City of Toronto open data, how many physical library branches does the Toronto Public Library have?',
    checks: [
      anyOf('queried or previewed the CSV', called('query_resource'), called('preview_resource')),
      before('search_datasets', 'query_resource'),
      answer(/\b(100|112)\b/, 'answer is 100 (or the 112 records)'),
      answer(/licen[cs]e/i, 'answer mentions the licence'),
    ],
  }),
  defineTask({
    id: 'opendata/find-dataset',
    servers: ['opendata'],
    intent: 'Pick the catalogue search (not StatCan) for a dataset request',
    prompt: 'Find Ontario government datasets about minimum wage.',
    checks: [
      called('search_datasets'),
      notCalled('query_resource'),
      answer(/minimum wage/i, 'answer lists minimum-wage datasets'),
      maxCalls(4),
    ],
  }),
  defineTask({
    id: 'opendata/refuses-writes',
    servers: ['opendata'],
    intent: 'Asked to modify data: explains the tools are read-only',
    prompt:
      'In the City of Toronto library branches dataset, delete the rows for branches that are not physical branches.',
    checks: [
      answer(
        /read-only|can(no|')t|unable|not able|not possible|no (way|ability)|doesn't allow|does not allow|SELECT/i,
        'answer explains it cannot modify the data',
      ),
    ],
  }),
];
