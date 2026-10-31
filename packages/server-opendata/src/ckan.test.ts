import { InvalidInputError } from '@abhijoshi23/porter-toolkit';
import { describe, expect, it } from 'vitest';
import { parseDatasetId } from './ckan.js';

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
