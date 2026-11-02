import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerId, ServerLaunch } from './types.js';

const PACKAGES: Record<ServerId, { pkg: string; name: string }> = {
  opendata: { pkg: '@abhijoshi23/porter-opendata', name: 'porter-opendata' },
  transit: { pkg: '@abhijoshi23/porter-transit', name: 'porter-transit' },
};

/** The built `dist/bin.js` of a workspace server, found through its package entry point. */
function binPath(pkg: string): string {
  return join(dirname(fileURLToPath(import.meta.resolve(pkg))), 'bin.js');
}

/**
 * How to start each server for an eval run. Every run shares one cache directory, so
 * the TTC schedule is downloaded and built once, not once per task. A long build wait
 * keeps a first-use download from showing up as a model failure.
 */
export function serverLaunches(ids: ServerId[], o: { cacheDir: string }): ServerLaunch[] {
  return ids.map((id) => ({
    id,
    name: PACKAGES[id].name,
    command: process.execPath,
    args: [binPath(PACKAGES[id].pkg)],
    env: {
      LOG_LEVEL: 'silent',
      PORTER_CACHE_DIR: o.cacheDir,
      PORTER_TRANSIT_BUILD_WAIT_MS: '180000',
    },
  }));
}
