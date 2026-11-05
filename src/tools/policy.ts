import { join } from 'node:path';
import type { AppConfig } from '../config/schema.ts';
import { languageOf } from '../shared/language.ts';
import { APP_ROOT, type AppPaths } from '../paths.ts';
import { resolveConfigPath, type ScopePolicy } from './hooks/scope.ts';

export function buildPolicy(config: AppConfig, paths: AppPaths): ScopePolicy {
  const roots = config.tools.roots.map(r => ({ path: resolveConfigPath(r.path, paths.data), mode: r.mode }));
  const protectedPaths = [
    paths.database, `${paths.database}-wal`, `${paths.database}-shm`, paths.config, `${paths.config}.bak`, paths.backups,
    join(APP_ROOT, '.env'), join(paths.data, 'tool_outputs'),
  ].map(p => resolveConfigPath(p, paths.data));
  const deny = [...config.tools.deny.map(p => resolveConfigPath(p, paths.data)), ...protectedPaths];
  // 人格とプロフィールは、Clive が書き換えるときに承認を求める（提案として見せる）
  const askOnWrite = ['SOUL.md', 'USER.md'].map(name => resolveConfigPath(join(paths.workspace, name), paths.data));
  return { roots, deny, askOnWrite, language: languageOf(config) };
}

export function defaultWorkspace(policy: ScopePolicy, paths: AppPaths): string {
  return policy.roots.find(r => r.mode === 'write')?.path ?? paths.workspace;
}
