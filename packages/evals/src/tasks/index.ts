import type { Task } from '../types.js';
import { opendataTasks } from './opendata.js';
import { quickbooksTasks } from './quickbooks.js';
import { tenderTasks } from './tenders.js';
import { transitTasks } from './transit.js';

export const SUITES: Record<string, Task[]> = {
  opendata: opendataTasks,
  transit: transitTasks,
  tenders: tenderTasks,
  quickbooks: quickbooksTasks,
};

export const ALL_TASKS: Task[] = Object.values(SUITES).flat();
