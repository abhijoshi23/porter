import type { Task } from '../types.js';
import { opendataTasks } from './opendata.js';
import { transitTasks } from './transit.js';

export const SUITES: Record<string, Task[]> = {
  opendata: opendataTasks,
  transit: transitTasks,
};

export const ALL_TASKS: Task[] = Object.values(SUITES).flat();
