import type { AskKind } from '../types.ts';

// 許可の一覧（allowlist*.ts）が、ふつうの確かめ（level 'ask'）として返す理由のキー → 確かめの種類（段 8b）。
// 自動承認の判定役に回してよいのは、種類が outside_read（シェルが許可フォルダの外を読む。これは shell-guard.ts がパスから決める）と
// risky_command（サービスの操作・リモートの設定）のときだけ。ここに無いキーは precheck（細かい種類なし）になり、自動では通らない。
// 外とやり取りする・外のコードを入れるもの（ask.package ほか）は egress で、判定役には回さない
export const ASK_REASON_KINDS: Readonly<Record<string, AskKind>> = {
  'ask.service': 'risky_command',
  'ask.git_remote': 'risky_command',
  'ask.package': 'egress',
  'ask.npx': 'egress',
  'ask.system_package': 'egress',
  'ask.curl': 'egress',
  'ask.wget': 'egress',
  'ask.powershell': 'egress',
  'ask.remote': 'egress',
  'ask.git_push': 'egress',
  'ask.gh': 'egress',
  'ask.container': 'egress',
  'list.lan': 'egress',
  'list.git_push': 'egress',
  'list.git_write': 'git_write',
};

export const askKindOf = (key: string): AskKind => ASK_REASON_KINDS[key] ?? 'precheck';
