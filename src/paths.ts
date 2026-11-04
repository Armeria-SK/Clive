import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface AppPaths {
  data: string;
  config: string;
  database: string;
  backups: string;
  uploads: string;
  workspace: string;
  templates: string;
  webDist: string;
}

export function resolvePaths(dataDir = process.env.CLIVE_DATA_DIR): AppPaths {
  const data = resolve(dataDir ?? join(APP_ROOT, 'data'));
  return {
    data,
    config: join(data, 'config.json'),
    database: join(data, 'clive.db'),
    backups: join(data, 'backups'),
    uploads: join(data, 'uploads'),
    workspace: join(data, 'workspace'),
    templates: join(APP_ROOT, 'templates'),
    webDist: join(APP_ROOT, 'web', 'dist'),
  };
}

export function loadEnvFile(path = join(APP_ROOT, '.env')): boolean {
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}
