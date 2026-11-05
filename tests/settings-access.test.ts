import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessKey, accessWidening } from '../web/src/settings/access.ts';
import { applyEdits, diffConfig } from '../web/src/settings/merge.ts';
import type { Config } from '../web/src/settings/model.ts';
import { en } from '../web/src/i18n/en.ts';
import { ja } from '../web/src/i18n/ja.ts';

function base(): Config {
  return {
    server: { host: '127.0.0.1', port: 4780, origins: [], tailscaleLogins: [] },
    tools: {
      roots: [{ path: 'workspace', mode: 'write' }, { path: '~/ref', mode: 'read' }],
      deny: ['~/.ssh', '~/.aws', '~/.gnupg', 'mine'],
      outsideRoots: 'ask',
      taintEscalation: true,
      shell: { enabled: true, allow: ['git status'], ask: ['npm *'], deny: ['rm *'], envAllow: ['PATH'], timeoutSec: 120 },
      hooks: { preToolUse: [{ matcher: 'shell_run', command: ['node', 'guard.js'], timeoutMs: 30000, onError: 'deny' }], postToolUse: [] },
      web: { fetch: true, search: 'duckduckgo' },
    },
    worker: { enabled: true, autonomy: false, selfTasksNeedApproval: true },
    memory: { userMaxChars: 1500 },
  };
}

const kinds = (before: Config, after: Config) => accessWidening(before, after).map(a => a.kind);

test('広がりの検出: 何も変えなければ無し。狭くなる変更や関係のない変更も無し', () => {
  assert.deepEqual(accessWidening(base(), structuredClone(base())), []);
  const narrower = structuredClone(base());
  narrower.tools.deny.push('~/secret');
  narrower.tools.roots = [{ path: 'workspace', mode: 'read' }];
  narrower.tools.shell.enabled = false;
  narrower.tools.shell.allow = [];
  narrower.tools.shell.ask.push('curl *');
  narrower.tools.shell.deny.push('sudo *');
  narrower.tools.shell.envAllow = [];
  narrower.tools.outsideRoots = 'deny';
  narrower.tools.web.fetch = false;
  narrower.server.origins = [];
  narrower.memory.userMaxChars = 9999;
  narrower.worker.autonomy = true;
  assert.deepEqual(accessWidening(base(), narrower), []);
});

test('広がりの検出（フォルダ）: 触れないパスを外す（初めから入っているものは印つき）・フォルダを足す・読むだけを読み書きにする', () => {
  const after = structuredClone(base());
  after.tools.deny = ['~/.aws', '~/.gnupg'];
  after.tools.roots.push({ path: '~', mode: 'read' });
  after.tools.roots[1].mode = 'write';
  assert.deepEqual(accessWidening(base(), after), [
    { kind: 'deny-removed', path: '~/.ssh', builtin: true },
    { kind: 'deny-removed', path: 'mine', builtin: false },
    { kind: 'root-write', path: '~/ref', broad: null },
    { kind: 'root-added', path: '~', mode: 'read', broad: 'home' },
  ]);
});

test('広がりの検出（JSON の欄からのフォルダ）: roots の追加と read → write は、設定全体を書き換えても拾う', () => {
  const draft = structuredClone(base());
  draft.tools.roots = [{ path: 'workspace', mode: 'write' }, { path: '~/ref', mode: 'write' }, { path: 'C:\\', mode: 'write' }];
  const merged = applyEdits(base(), diffConfig(base(), draft));
  assert.deepEqual(accessWidening(base(), merged.config), [
    { kind: 'root-write', path: '~/ref', broad: null },
    { kind: 'root-added', path: 'C:\\', mode: 'write', broad: 'filesystem' },
  ]);
});

test('広がりの検出（シェル）: 有効にする・承認なしに足す・承認や止めるから外す・環境変数を渡す', () => {
  const off = base();
  off.tools.shell.enabled = false;
  const on = structuredClone(off);
  on.tools.shell.enabled = true;
  assert.deepEqual(kinds(off, on), ['shell-enabled']);
  const after = structuredClone(base());
  after.tools.shell.allow.push('curl *');
  after.tools.shell.ask = [];
  after.tools.shell.deny = [];
  after.tools.shell.envAllow.push('OPENAI_API_KEY');
  assert.deepEqual(accessWidening(base(), after), [
    { kind: 'shell-allow-added', command: 'curl *' },
    { kind: 'shell-ask-removed', command: 'npm *' },
    { kind: 'shell-deny-removed', command: 'rm *' },
    { kind: 'shell-env-added', name: 'OPENAI_API_KEY' },
  ]);
});

test('広がりの検出（承認まわり・Web）: outsideRoots を止めるから承認に・外の内容のあとの引き上げを切る・取得と検索を入れる・自分で作ったタスクの承認を外す', () => {
  const strict = base();
  strict.tools.outsideRoots = 'deny';
  strict.tools.web.fetch = false;
  strict.tools.web.search = 'off';
  const loose = structuredClone(strict);
  loose.tools.outsideRoots = 'ask';
  loose.tools.taintEscalation = false;
  loose.tools.web.fetch = true;
  loose.tools.web.search = 'duckduckgo';
  loose.worker.selfTasksNeedApproval = false;
  assert.deepEqual(kinds(strict, loose), ['outside-loosened', 'taint-off', 'web-fetch-on', 'web-search-on', 'self-tasks-unapproved']);
  const tightened = structuredClone(base());
  tightened.tools.taintEscalation = true;
  assert.deepEqual(kinds(base(), tightened), []);
  const alreadyOff = base();
  alreadyOff.tools.taintEscalation = false;
  assert.deepEqual(kinds(alreadyOff, structuredClone(alreadyOff)), [], 'もう切ってあるものは、変えていなければ数えない');
});

test('広がりの検出（フック）: 足す・書き換える・使う前のものを外す。同じ中身や並べ替えだけなら無し、使ったあとのフックを外すのは数えない', () => {
  const hook = (matcher: string, ...command: string[]) => ({ matcher, command, timeoutMs: 1000, onError: 'deny' });
  const before = base();
  before.tools.hooks = { preToolUse: [hook('a', 'x'), hook('b', 'y')], postToolUse: [hook('p', 'z')] };

  const added = structuredClone(before);
  added.tools.hooks.preToolUse.push(hook('c', 'w'));
  assert.deepEqual(accessWidening(before, added), [{ kind: 'hook-added', stage: 'preToolUse', hook: { matcher: 'c', command: ['w'] } }]);

  const edited = structuredClone(before);
  edited.tools.hooks.preToolUse[1] = { ...hook('b', 'y', '--loose'), onError: 'ask' };
  assert.deepEqual(accessWidening(before, edited), [{ kind: 'hook-edited', stage: 'preToolUse', hook: { matcher: 'b', command: ['y', '--loose'] } }]);

  const reordered = structuredClone(before);
  reordered.tools.hooks.preToolUse.reverse();
  assert.deepEqual(accessWidening(before, reordered), [], '並べ替えだけなら変わっていない');

  const removedPre = structuredClone(before);
  removedPre.tools.hooks.preToolUse = [hook('a', 'x')];
  assert.deepEqual(accessWidening(before, removedPre), [{ kind: 'hook-removed', stage: 'preToolUse', hook: { matcher: 'b', command: ['y'] } }]);

  const removedPost = structuredClone(before);
  removedPost.tools.hooks.postToolUse = [];
  assert.deepEqual(accessWidening(before, removedPost), [], '使ったあとのフックを外しても、道具を止める力は減らない');

  const swapOne = structuredClone(before);
  swapOne.tools.hooks.preToolUse = [hook('a', 'x'), hook('c', 'w'), hook('d', 'v')];
  assert.deepEqual(accessWidening(before, swapOne).map(a => a.kind), ['hook-edited', 'hook-added'], '1 つ書き換え + 1 つ追加');

  const post = structuredClone(before);
  post.tools.hooks.postToolUse.push(hook('q', 'r'));
  assert.deepEqual(accessWidening(before, post), [{ kind: 'hook-added', stage: 'postToolUse', hook: { matcher: 'q', command: ['r'] } }]);
});

test('広がりの検出（外からの入口）: 開ける場所を足す・Tailscale の許可を増やす / 空にする・待ち受けを外へ', () => {
  const before = base();
  before.server.tailscaleLogins = ['me@example.com'];
  const after = structuredClone(before);
  after.server.origins = ['http://a.ts.net'];
  after.server.tailscaleLogins = ['me@example.com', 'you@example.com'];
  after.server.host = '0.0.0.0';
  assert.deepEqual(accessWidening(before, after), [
    { kind: 'origin-added', origin: 'http://a.ts.net' },
    { kind: 'login-added', login: 'you@example.com' },
    { kind: 'host-exposed', host: '0.0.0.0' },
  ]);
  const cleared = structuredClone(before);
  cleared.server.tailscaleLogins = [];
  assert.deepEqual(accessWidening(before, cleared), [{ kind: 'logins-cleared' }]);
  const first = structuredClone(base());
  first.server.tailscaleLogins = ['me@example.com'];
  assert.deepEqual(accessWidening(base(), first), [], '空のとき（誰でも）に足すのは、狭くなる');
  const back = structuredClone(after);
  back.server.host = 'localhost';
  assert.equal(accessWidening({ ...after }, back).some(a => a.kind === 'host-exposed'), false, '内向きの名前に戻すのは広がりではない');
  const same = structuredClone(after);
  assert.equal(accessWidening(after, same).some(a => a.kind === 'host-exposed'), false, '変えていなければ数えない');
});

test('広がりの検出: 項目が無い設定でも落ちず、既定値で比べる', () => {
  assert.deepEqual(accessWidening({}, {}), []);
  assert.deepEqual(accessWidening({}, { tools: { shell: { enabled: true } } }), [], '既定ですでに有効');
  assert.deepEqual(accessWidening({ tools: { shell: { enabled: false } } }, { tools: {} }), ['shell-enabled'].map(kind => ({ kind })), '項目が消えると既定（有効）に戻る');
  assert.deepEqual(accessWidening({ tools: null }, { tools: 'x', server: [] } as Config), []);
});

test('保存の流れ: 最新の設定と、自分の編集を当てた結果を比べるので、ほかの場所が先に広げた分は確認に出ない', () => {
  const saved = base();
  const latest = structuredClone(saved);
  latest.tools.deny = ['~/.aws', '~/.gnupg', 'mine'];
  latest.tools.shell.envAllow.push('SECRET');
  const draft = structuredClone(saved);
  draft.memory.userMaxChars = 2000;
  const merged = applyEdits(latest, diffConfig(saved, draft));
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(accessWidening(latest, merged.config), [], '自分が広げたものだけが対象');
  const draft2 = structuredClone(saved);
  draft2.tools.shell.allow.push('wget *');
  const merged2 = applyEdits(latest, diffConfig(saved, draft2));
  assert.deepEqual(accessWidening(latest, merged2.config), [{ kind: 'shell-allow-added', command: 'wget *' }]);
});

test('確認の印: 同じ広がりなら同じ、違えば違う', () => {
  const a = accessWidening(base(), Object.assign(structuredClone(base()), { server: { host: '0.0.0.0' } }));
  const b = accessWidening(base(), Object.assign(structuredClone(base()), { server: { host: '0.0.0.0' } }));
  assert.equal(accessKey(a), accessKey(b));
  assert.notEqual(accessKey(a), accessKey([]));
});

test('辞書: 広がりの文は ja と en の両方にあり、en は ja の写しではない', () => {
  const keys = Object.keys(ja).filter(k => k.startsWith('access.'));
  assert.ok(keys.length >= 17, `${keys.length} 件しか読めていない`);
  for (const key of keys) {
    const jaEntry = (ja as Record<string, unknown>)[key];
    const enEntry = (en as Record<string, unknown>)[key];
    assert.equal(typeof enEntry, typeof jaEntry, key);
    if (typeof jaEntry === 'string') assert.notEqual(enEntry, jaEntry, `${key}: 訳し忘れ`);
  }
  const line = (ja['access.hookAdded'] as (a: string, b: string) => string)('使う前', 'shell_run → node guard.js');
  assert.equal(line, 'フックを足す（使う前）: shell_run → node guard.js');
});
