import { InvalidInputError } from '@abhijoshi23/porter-toolkit';
import { describe, expect, it } from 'vitest';
import { absoluteUrl, parseDatasetId } from './ckan.js';

describe('parseDatasetId', () => {
  it('splits portal and name', () => {
    expect(parseDatasetId('toronto:library-branch-general-information')).toEqual({
      portal: 'toronto',
      name: 'library-branch-general-information',
    });
    expect(parseDatasetId(' canada:196ae6b1-b1af-4c0a-96a8-9f66db457718 ').portal).toBe('canada');
  });

  it.each(['library-branch', 'quebec:abc', 'ontario:', 'ontario:../../etc/passwd', 'ontario:a b'])(
    'rejects %s with guidance',
    (id) => {
      expect(() => parseDatasetId(id)).toThrow(InvalidInputError);
    },
  );
});

describe('absoluteUrl', () => {
  const api = 'https://open.canada.ca/data/api/3/action';
  it('resolves the relative resource URLs package_search returns on open.canada.ca', () => {
    expect(absoluteUrl('/data/dataset/x/resource/y/download/wages.csv', api)).toBe(
      'https://open.canada.ca/data/dataset/x/resource/y/download/wages.csv',
    );
    expect(absoluteUrl('https://example.org/a.csv', api)).toBe('https://example.org/a.csv');
  });
  it('drops empty URLs and non-http schemes', () => {
    expect(absoluteUrl('', api)).toBeNull();
    expect(absoluteUrl('file:///etc/passwd', api)).toBeNull();
    expect(absoluteUrl('javascript:alert(1)', api)).toBeNull();
  });
});
