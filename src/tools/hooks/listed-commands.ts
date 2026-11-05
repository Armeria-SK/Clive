// 画面が、tools.shell.allow に足すときの注意の出し分けに使う: その項目は、一覧に無いコードを確かめずに動かすことになるか

import { classifyStatements, noRepo } from './allowlist.ts';

export function allowEntryRunsCode(entry: string): boolean {
  for (const shell of ['bash', 'powershell'] as const) {
    const classified = classifyStatements(entry, { shell, windows: false, repo: noRepo, selfHosts: [] });
    if (classified.results.some(r => r.reasons.some(x => x.level === 'once' && x.exempt))) return true;
  }
  return false;
}
