import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

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

// 起動したあとに .env へ足した鍵を読み込む（画面のはじめの設定の「.env を読み直す」）。process.loadEnvFile と同じく、すでにある変数は上書きしない。
// 書かれている値が今の値と違う変数は、起動し直さないと変わらないので、名前だけ返す（値は返さない）。読むのは決まった .env だけで、パスは受け取らない。
export function reloadEnvFile(path = join(APP_ROOT, '.env')): { loaded: boolean; notApplied: string[] } {
  if (!existsSync(path)) return { loaded: false, notApplied: [] };
  const notApplied: string[] = [];
  let parsed: Record<string, string>;
  try { parsed = parseEnv(readFileSync(path, 'utf8')) as Record<string, string>; } catch { return { loaded: false, notApplied: [] }; }
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value;
    else if (process.env[key] !== value) notApplied.push(key);
  }
  return { loaded: true, notApplied };
}

export function loadEnvFile(path = join(APP_ROOT, '.env')): boolean {
  if (!existsSync(path)) return false;
  process.loadEnvFile(path);
  return true;
}
