import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyEdits, deepEqual, diffConfig, editPath, profilePatch } from '../web/src/settings/merge.ts';
import { blockUnload, type Config } from '../web/src/settings/model.ts';

function sample(): Config {
  return {
    timezone: 'Asia/Tokyo',
    language: 'ja',
    server: { port: 4780, origins: ['http://a.ts.net'] },
    providers: [{ id: 'local', kind: 'openai_compatible', maxParallel: 1 }, { id: 'claude', kind: 'anthropic', maxParallel: 2 }],
    models: [
      { id: 'big', provider: 'local', model: 'qwen', contextLength: 32768, vision: false },
      { id: 'sonnet', provider: 'claude', model: 'claude-sonnet', vision: true },
    ],
    routing: { chat: ['big', 'sonnet'], background: ['big'] },
    tools: { deny: ['.env'], roots: [{ path: 'workspace', mode: 'write' }], hooks: { preToolUse: [], postToolUse: [] }, shell: { enabled: true, allow: [] } },
    worker: { enabled: true, autonomy: false, maxRunsPerHour: 6 },
    memory: { userMaxChars: 1500, notesMaxChars: 2500 },
    profile: { name: 'Clive', shape: 'orb', color: '#C9A227', motion: 'auto' },
  };
}

// 保存の流れ: 画面を開いたときの設定（saved）→ 編集中（draft）の差を、最新の設定（latest）へ当てる。
function merge(saved: Config, draft: Config, latest: Config) {
  return applyEdits(latest, diffConfig(saved, draft));
}

test('差: 何も変えていなければ空。キーの順番が違っても同じ', () => {
  const saved = sample();
  assert.deepEqual(diffConfig(saved, structuredClone(saved)), []);
  const reordered = Object.fromEntries(Object.entries(saved).reverse());
  assert.deepEqual(diffConfig(saved, reordered), []);
  assert.equal(deepEqual({ a: 1, b: undefined }, { a: 1 }), true, 'undefined のキーは無いのと同じ');
  assert.equal(deepEqual([1, 2], [2, 1]), false);
});

test('差: 値の編集・キーの削除・id を持つ一覧の追加 / 削除 / 項目の中の編集に分かれ、それ以外の一覧は 1 つの値', () => {
  const saved = sample();
  const draft = structuredClone(saved);
  draft.memory.userMaxChars = 2000;
  delete draft.language;
  draft.models[0].contextLength = 65536;
  draft.models.push({ id: 'tiny', provider: 'local', model: 't' });
  draft.providers = draft.providers.filter((p: { id: string }) => p.id !== 'claude');
  draft.tools.deny = ['.env', '~/.ssh'];
  draft.tools.hooks.preToolUse = [{ matcher: '.*', command: ['node', 'x.js'], timeoutMs: 1000, onError: 'deny' }];
  const edits = diffConfig(saved, draft);
  assert.deepEqual(edits.map(e => `${e.type}:${editPath(e)}`).sort(), [
    'addItem:models.tiny',
    'removeItem:providers.claude',
    'set:language',
    'set:memory.userMaxChars',
    'set:models.big.contextLength',
    'set:tools.deny',
    'set:tools.hooks.preToolUse',
  ]);
  const reordered = structuredClone(saved);
  reordered.models.reverse();
  assert.deepEqual(diffConfig(saved, reordered), [], 'models の並べ替えだけは編集にしない');
});

test('保存の合流（自発行動の場面）: 右のパネルが先に変えた worker.autonomy を、設定の保存が巻き戻さない', () => {
  const saved = sample();
  const draft = structuredClone(saved);
  draft.memory.userMaxChars = 2000;
  const latest = structuredClone(saved);
  latest.worker.autonomy = true;
  const result = merge(saved, draft, latest);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.config.worker.autonomy, true, '先に変わっていた値は残る');
  assert.equal(result.config.memory.userMaxChars, 2000, '自分の編集は入る');
  assert.deepEqual(latest.worker, { enabled: true, autonomy: true, maxRunsPerHour: 6 }, '最新の設定そのものは書き換えない');
  assert.equal(JSON.stringify({ ...result.config, memory: undefined }), JSON.stringify({ ...latest, memory: undefined }), 'ほかは最新のまま');
  assert.equal(JSON.stringify(draft).includes('"autonomy":true'), false, '編集中の設定は最新で上書きされない');
});

test('保存の合流: 触った所を先に変えられていたら衝突で、場所を返す', () => {
  const saved = sample();
  const draft = structuredClone(saved);
  draft.worker.maxRunsPerHour = 10;
  draft.models[0].contextLength = 65536;
  const latest = structuredClone(saved);
  latest.worker.maxRunsPerHour = 8;
  latest.models[0].contextLength = 16384;
  const result = merge(saved, draft, latest);
  assert.deepEqual(result.conflicts.map(c => c.path).sort(), ['models.big.contextLength', 'worker.maxRunsPerHour']);
});

test('保存の合流: 先に同じ値になっていれば衝突ではない', () => {
  const saved = sample();
  const draft = structuredClone(saved);
  draft.worker.autonomy = true;
  draft.models.push({ id: 'tiny', provider: 'local', model: 't' });
  const latest = structuredClone(draft);
  const result = merge(saved, draft, latest);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.config, latest);
  assert.equal(result.config.models.filter((m: { id: string }) => m.id === 'tiny').length, 1, '二重に足さない');
});

test('保存の合流: 一覧は id で合わせる（先に別の項目が足された・消された）', () => {
  const saved = sample();
  const draft = structuredClone(saved);
  draft.models[0].contextLength = 65536;
  draft.models.push({ id: 'mine', provider: 'local', model: 'm' });
  const latest = structuredClone(saved);
  latest.models.push({ id: 'theirs', provider: 'local', model: 'x' });
  const result = merge(saved, draft, latest);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.config.models.map((m: { id: string }) => m.id), ['big', 'sonnet', 'theirs', 'mine'], '先に足された項目も残り、自分の追加も入る');
  assert.equal(result.config.models[0].contextLength, 65536);

  const gone = structuredClone(saved);
  gone.models = gone.models.filter((m: { id: string }) => m.id !== 'big');
  assert.deepEqual(merge(saved, draft, gone).conflicts.map(c => c.path), ['models.big.contextLength'], '編集したい項目が先に消されていたら衝突');

  const sameId = structuredClone(saved);
  sameId.models.push({ id: 'mine', provider: 'claude', model: 'different' });
  assert.deepEqual(merge(saved, draft, sameId).conflicts.map(c => c.path), ['models.mine'], '同じ id の別の項目が先に足されていたら衝突');
});

test('保存の合流: 項目の削除は、先に編集されていたら衝突、先に消されていれば何もしない', () => {
  const saved = sample();
  const draft = structuredClone(saved);
  draft.models = draft.models.filter((m: { id: string }) => m.id !== 'sonnet');
  draft.routing.chat = ['big'];
  const edited = structuredClone(saved);
  edited.models[1].vision = false;
  assert.deepEqual(merge(saved, draft, edited).conflicts.map(c => c.path), ['models.sonnet']);
  const already = structuredClone(draft);
  const result = merge(saved, draft, already);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.config, already);
});

test('保存の合流: タグ・順番・フックのような一覧は、1 つの値として比べる', () => {
  const saved = sample();
  const draft = structuredClone(saved);
  draft.tools.deny = ['.env', '~/.ssh'];
  const changedElsewhere = structuredClone(saved);
  changedElsewhere.tools.deny = ['.env', '~/.aws'];
  assert.deepEqual(merge(saved, draft, changedElsewhere).conflicts.map(c => c.path), ['tools.deny']);
  const other = structuredClone(saved);
  other.tools.shell.enabled = false;
  const ok = merge(saved, draft, other);
  assert.deepEqual(ok.conflicts, []);
  assert.deepEqual(ok.config.tools.deny, ['.env', '~/.ssh']);
  assert.equal(ok.config.tools.shell.enabled, false);
});

test('保存の合流: キーの削除（auto = language を消す）も、先に変えられていたら衝突', () => {
  const saved = sample();
  const draft = structuredClone(saved);
  delete draft.language;
  const latest = structuredClone(saved);
  latest.language = 'en';
  assert.deepEqual(merge(saved, draft, latest).conflicts.map(c => c.path), ['language']);
  const untouched = structuredClone(saved);
  const result = merge(saved, draft, untouched);
  assert.deepEqual(result.conflicts, []);
  assert.equal('language' in result.config, false);
});

test('保存の合流: 無かったキーを足す（latest に親も無いときは親を作る）', () => {
  const saved = sample();
  delete saved.tools.hooks;
  const draft = structuredClone(saved);
  draft.tools.hooks = { preToolUse: [{ matcher: 'x', command: ['a'], timeoutMs: 100, onError: 'ask' }] };
  const latest = structuredClone(saved);
  const result = merge(saved, draft, latest);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.config.tools.hooks.preToolUse.length, 1);
  const nested = structuredClone(saved);
  delete nested.worker;
  const d2 = structuredClone(saved);
  d2.worker.maxRunsPerHour = 9;
  assert.deepEqual(merge(saved, d2, nested).conflicts.map(c => c.path), ['worker.maxRunsPerHour'], '値のあった親が先に消されていたら衝突');
});

test('保存の合流: プロフィールだけの編集でも、先に変わった別の項目は残る', () => {
  const saved = sample();
  const draft = structuredClone(saved);
  draft.profile.name = 'Neo';
  const latest = structuredClone(saved);
  latest.profile.color = '#112233';
  const result = merge(saved, draft, latest);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.config.profile, { name: 'Neo', shape: 'orb', color: '#112233', motion: 'auto' });
});

test('プロフィールだけの保存: 触った項目だけを送り、ほかの設定が混ざるとき・プロフィールごと消すときは使わない', () => {
  const saved = sample();
  const only = structuredClone(saved);
  only.profile.name = 'Neo';
  only.profile.motion = 'float';
  assert.deepEqual(profilePatch(diffConfig(saved, only)), { name: 'Neo', motion: 'float' });
  const mixed = structuredClone(only);
  mixed.worker.maxRunsPerHour = 9;
  assert.equal(profilePatch(diffConfig(saved, mixed)), null);
  const wholly = structuredClone(saved);
  delete wholly.profile;
  assert.equal(profilePatch(diffConfig(saved, wholly)), null);
  assert.equal(profilePatch(diffConfig(saved, structuredClone(saved))), null, '編集が無ければ null');
  const other = structuredClone(saved);
  other.memory.userMaxChars = 1;
  assert.equal(profilePatch(diffConfig(saved, other)), null, 'プロフィールに触っていなければ null');
});

test('保存の合流（JSON の欄）: 設定全体を書き換えても、触った所だけが当たる', () => {
  const saved = sample();
  const draft = structuredClone(saved);
  draft.timezone = 'Europe/London';
  draft.extra = { note: 'new key' };
  draft.worker = { ...draft.worker };
  const latest = structuredClone(saved);
  latest.worker.autonomy = true;
  const result = merge(saved, draft, latest);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.config.timezone, 'Europe/London');
  assert.deepEqual(result.config.extra, { note: 'new key' });
  assert.equal(result.config.worker.autonomy, true, 'JSON の欄で触っていない値は最新のまま');
});

test('合流は入力を書き換えない', () => {
  const saved = sample();
  const draft = structuredClone(saved);
  draft.models.push({ id: 'tiny', provider: 'local', model: 't', nested: { a: [1] } });
  const latest = structuredClone(saved);
  const frozen = [structuredClone(saved), structuredClone(draft), structuredClone(latest)];
  const result = merge(saved, draft, latest);
  assert.deepEqual([saved, draft, latest], frozen);
  (result.config.models.at(-1) as { nested: { a: number[] } }).nested.a.push(2);
  assert.deepEqual(draft.models.at(-1).nested.a, [1], '返した設定を触っても、編集中の設定は変わらない');
});

test('ページを閉じる前の確認: 既定の動きを止め、returnValue を空文字にする（ブラウザが確認を出す条件）', () => {
  const event = { prevented: false, returnValue: undefined as unknown, preventDefault() { this.prevented = true; } };
  blockUnload(event);
  assert.equal(event.prevented, true);
  assert.equal(event.returnValue, '');
});
