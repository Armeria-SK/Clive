import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { classifyHttpFailure } from '../src/providers/http.ts';
import { startApp, waitFor } from './app-setup.ts';
import { fakeModel } from './app-setup.ts';
import { fail } from './helpers.ts';

// 段 9f: API キーを画面から入れる（PUT / GET / DELETE /api/providers/:id/key）。
// 鍵は .env にだけ書く。応答・ログ・実行ログ・お知らせ・エラーの文・SSE・DB のどこにも残らない

// 鍵らしい形（sk- など）だと、伏せ字の処理に隠れて漏れを見逃すので、どの形にも当たらない文字列を使う
const KEY = 'Zk3qP9xW7mB2vN8cLd5Tq1';
const KEY2 = 'Rt6yH4nJ8vC1xA9sFg2Uw0';

type Env = Record<string, string | undefined>;

function extra(c: { providers: Array<Record<string, unknown>>; models: Array<Record<string, unknown>>; routing: { chat: string[] } }) {
  c.providers.push({ id: 'my-llm', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:1/v1', maxParallel: 1, timeoutMs: 10_000 });
  c.providers.push({ id: 'other', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:2/v1', maxParallel: 1, timeoutMs: 10_000 });
  c.models.push(fakeModel('m3', { provider: 'my-llm' }));
  c.routing.chat.push('m3');
}

async function start(t: Parameters<typeof startApp>[0], env: Env = {}, configure: (c: any) => void = () => undefined) {
  const s = await startApp(t, { env, configure: c => { extra(c as never); configure(c); } });
  const put = (id: string, body: unknown) => s.json(`/api/providers/${id}/key`, 'PUT', body);
  return { ...s, env, put, get: (id: string) => s.json(`/api/providers/${id}/key`, 'GET'), del: (id: string) => s.json(`/api/providers/${id}/key`, 'DELETE') };
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path)); else out.push(path);
  }
  return out;
}

// 鍵の文字列が、.env 以外のどこかにあれば、その場所を返す
async function whereIs(s: Awaited<ReturnType<typeof start>>, secret: string, seen: string[]): Promise<string[]> {
  const found: string[] = [];
  const check = (place: string, text: string) => { if (text.includes(secret)) found.push(place); };
  seen.forEach((text, i) => check(`応答 ${i}`, text));
  for (const path of ['/api/settings', '/api/models', '/api/runs', '/api/tool-calls', '/api/notifications', '/api/health', '/api/tasks', '/api/approvals', '/api/onboarding', '/api/conversations', '/api/memories', '/api/providers/fake/key', '/api/providers/my-llm/key']) {
    check(path, await (await s.api(path)).text());
  }
  for (const file of filesUnder(s.paths.data)) {
    if (file === s.paths.env || file === `${s.paths.env}.bak`) continue;
    check(`ファイル ${file}`, readFileSync(file).toString('latin1') + readFileSync(file, 'utf8'));
  }
  const tables = (s.app.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(r => r.name);
  for (const table of tables) {
    try { check(`DB ${table}`, JSON.stringify(s.app.db.prepare(`SELECT * FROM "${table}"`).all())); } catch { }
  }
  check('ログ', s.logs.join('\n'));
  check('お知らせ', JSON.stringify(s.app.notifications.list(200)));
  return found;
}

test('キーを入れる: .env に 1 行、設定に apiKeyEnv（ID から作った名前）、今の実行にも効く。応答は { set, last4 } だけ。GET も同じ形', async t => {
  const s = await start(t);
  assert.deepEqual((await s.get('my-llm')).body, { set: false, last4: null }, '入れる前');
  const res = await s.put('my-llm', { key: KEY });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { set: true, last4: KEY.slice(-4) });
  assert.equal(readFileSync(s.paths.env, 'utf8'), `CLIVE_MY_LLM_API_KEY=${KEY}\n`);
  assert.equal(s.env.CLIVE_MY_LLM_API_KEY, KEY, '起動し直さなくても効く');
  assert.equal(s.app.config().providers.find(p => p.id === 'my-llm')!.apiKeyEnv, 'CLIVE_MY_LLM_API_KEY');
  assert.deepEqual((await s.get('my-llm')).body, { set: true, last4: KEY.slice(-4) });
  assert.deepEqual(Object.keys((await s.get('my-llm')).body).sort(), ['last4', 'set']);
});

test('今ある apiKeyEnv があれば、その名前を使う（設定は変えない）。入れ直すと置き換わり、控えは 1 つ', async t => {
  const s = await start(t);
  const before = readFileSync(s.paths.config, 'utf8');
  assert.equal((await s.put('fake', { key: KEY })).status, 200);
  assert.equal(readFileSync(s.paths.env, 'utf8'), `FAKE_KEY=${KEY}\n`);
  assert.equal(readFileSync(s.paths.config, 'utf8'), before, '設定ファイルは書き直さない');
  assert.equal((await s.put('fake', { key: KEY2 })).status, 200);
  assert.equal(readFileSync(s.paths.env, 'utf8'), `FAKE_KEY=${KEY2}\n`);
  assert.equal(readFileSync(`${s.paths.env}.bak`, 'utf8'), `FAKE_KEY=${KEY}\n`);
  assert.deepEqual(readdirSync(join(s.paths.env, '..')).filter(n => n.startsWith('.env')).sort(), ['.env', '.env.bak']);
  assert.equal(s.env.FAKE_KEY, KEY2);
});

test('.env のほかの行・コメント・順番はそのまま残る。消すと、その行だけ消える', async t => {
  const s = await start(t);
  const original = '# 私の鍵\nANTHROPIC_API_KEY=sk-ant-keepme-0000\n\nOTHER_SETTING=1\n';
  writeFileSync(s.paths.env, original);
  assert.equal((await s.put('my-llm', { key: KEY })).status, 200);
  assert.equal(readFileSync(s.paths.env, 'utf8'), `${original}CLIVE_MY_LLM_API_KEY=${KEY}\n`);
  assert.equal(readFileSync(`${s.paths.env}.bak`, 'utf8'), original);
  const gone = await s.del('my-llm');
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.body, { set: false, last4: null });
  assert.equal(readFileSync(s.paths.env, 'utf8'), original);
  assert.equal(s.env.CLIVE_MY_LLM_API_KEY, undefined, '消したら、動いている Clive からも消える');
  assert.deepEqual((await s.get('my-llm')).body, { set: false, last4: null });
  assert.equal((await s.del('my-llm')).status, 200, '無くても消せる（何もしない）');
});

test('書いたあと、モデルの確認をやり直す（鍵の名前が増えたときも、同じ名前に入れ直したときも、消したときも）', async t => {
  const s = await start(t);
  const checkedAt = () => s.app.status.get('m3')!.checkedAt;
  const later = async (action: () => Promise<unknown>) => { const before = checkedAt(); await new Promise(r => setTimeout(r, 5)); await action(); return [before, checkedAt()] as const; };
  const [a0, a1] = await later(() => s.put('my-llm', { key: KEY }));
  assert.ok(a1 > a0, `設定が変わったあと、確認し直した（${a0} → ${a1}）`);
  const [b0, b1] = await later(() => s.put('my-llm', { key: KEY2 }));
  assert.ok(b1 > b0, `同じ名前に入れ直したあとも確認し直した（${b0} → ${b1}）`);
  const [c0, c1] = await later(() => s.del('my-llm'));
  assert.ok(c1 > c0, `消したあとも確認し直す（${c0} → ${c1}）`);
});

test('鍵の文字列は、応答・ログ・実行ログ・お知らせ・SSE・DB・設定ファイルのどこにも残らない（.env だけ）', async t => {
  const s = await start(t);
  const events: string[] = [];
  const stop = s.app.bus.subscribe(e => events.push(JSON.stringify(e)));
  t.after(stop);
  const seen: string[] = [];
  for (const [id, key] of [['my-llm', KEY], ['fake', KEY2]] as const) {
    const res = await s.api(`/api/providers/${id}/key`, { method: 'PUT', body: JSON.stringify({ key }) });
    seen.push(await res.text());
    seen.push(await (await s.api(`/api/providers/${id}/key`)).text());
  }
  // 失敗した要求の応答にも入らない
  for (const bad of [`${KEY}\n`, ` ${KEY}`, `${KEY}\u0000`]) {
    const res = await s.api('/api/providers/my-llm/key', { method: 'PUT', body: JSON.stringify({ key: bad }) });
    assert.equal(res.status, 400);
    seen.push(await res.text());
  }
  const sse = await (async () => {
    const controller = new AbortController();
    const res = await fetch(`${s.origin}/api/events`, { headers: { Origin: s.origin }, signal: controller.signal });
    const reader = res.body!.getReader();
    let text = '';
    const stopAt = Date.now() + 300;
    try { while (Date.now() < stopAt) { const part = await Promise.race([reader.read(), new Promise<null>(r => setTimeout(() => r(null), 100))]); if (part && !part.done) text += new TextDecoder().decode(part.value); if (part?.done) break; } } finally { controller.abort(); }
    return text;
  })();
  seen.push(sse, ...events);
  for (const key of [KEY, KEY2]) assert.deepEqual(await whereIs(s, key, seen), [], `${key.slice(0, 4)}… が残っている場所`);
  const env = readFileSync(s.paths.env, 'utf8');
  assert.equal(env.split(KEY).length - 1, 1, '.env には 1 回だけ');
});

test('改行・制御文字・前後の空白・空・長すぎる鍵は 400 で、何も書かない', async t => {
  const s = await start(t);
  const before = readFileSync(s.paths.config, 'utf8');
  for (const key of ['a\nb', 'a\r\nb', `${KEY}\n`, `${KEY}\r`, `${KEY}\t`, 'a\u0000b', 'a\u001bb', 'a\u007fb', ` ${KEY}`, `${KEY} `, `${KEY}${String.fromCharCode(0xa0)}`, '   ', 'x'.repeat(3000)]) {
    const res = await s.put('my-llm', { key });
    assert.equal(res.status, 400, JSON.stringify(key).slice(0, 40));
    assert.equal(res.body.error, 'invalid_field');
    assert.equal(res.body.field, 'key');
    assert.ok(typeof res.body.message === 'string' && res.body.message.length > 0);
    assert.ok(!JSON.stringify(res.body).includes(key.trim() || '\u0001'), '鍵を応答に返さない');
  }
  for (const body of [{}, { key: '' }, { key: 5 }, { key: null }, { key: ['a'] }, [], 'x']) {
    assert.equal((await s.put('my-llm', body)).status, 400, JSON.stringify(body));
  }
  assert.equal(existsSync(s.paths.env), false, '.env を作らない');
  assert.equal(readFileSync(s.paths.config, 'utf8'), before);
  assert.equal(s.env.CLIVE_MY_LLM_API_KEY, undefined);
});

test('三種類の引用符と # をすべて含む鍵は、.env に安全に書けないので 400（何も書かない）', async t => {
  const s = await start(t);
  const key = `abc#'"${String.fromCharCode(96)}xyz`;
  const res = await s.put('my-llm', { key });
  assert.equal(res.status, 400);
  assert.equal(res.body.field, 'key');
  assert.equal(existsSync(s.paths.env), false);
  assert.equal(s.app.config().providers.find(p => p.id === 'my-llm')!.apiKeyEnv, undefined, '設定も変えない');
  assert.equal(JSON.stringify(res.body).includes('xyz'), false);
});

test('知らないプロバイダは 404。ID の形が変でも同じ（環境変数の名前を作らない）', async t => {
  const s = await start(t);
  for (const id of ['nope', 'A%20B', '..%2F..', 'CLIVE_X_API_KEY']) {
    assert.equal((await s.put(id, { key: KEY })).status, 404, id);
    assert.equal((await s.get(id)).status, 404, id);
    assert.equal((await s.del(id)).status, 404, id);
  }
  assert.equal(existsSync(s.paths.env), false);
});

test('Origin・Sec-Fetch-Site・Host の確かめは、ほかの書き込みと同じに効く（通らなければ .env も設定も変わらない）', async t => {
  const s = await start(t);
  const before = readFileSync(s.paths.config, 'utf8');
  const body = JSON.stringify({ key: KEY });
  const url = `${s.origin}/api/providers/my-llm/key`;
  const cases: Array<[string, Record<string, string>]> = [
    ['別の Origin', { Origin: 'http://evil.example', 'Content-Type': 'application/json' }],
    ['Origin なし', { 'Content-Type': 'application/json' }],
    ['別のサイトから', { Origin: s.origin, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' }],
    ['同じサイトの別のポート', { Origin: s.origin, 'Sec-Fetch-Site': 'same-site', 'Content-Type': 'application/json' }],
  ];
  for (const [name, headers] of cases) {
    const res = await fetch(url, { method: 'PUT', body, headers });
    assert.equal(res.status, 403, name);
    assert.equal((await fetch(url, { method: 'DELETE', headers })).status, 403, `${name}（DELETE）`);
  }
  const readOnly = await fetch(url, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(readOnly.status, 403, '読むほうも同じ');
  const status = await new Promise<number>((resolve, reject) => {
    const u = new URL(url);
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'PUT', headers: { Host: 'evil.example', Origin: s.origin, 'Content-Type': 'application/json' } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(status, 403, '別の Host');
  assert.equal(existsSync(s.paths.env), false);
  assert.equal(readFileSync(s.paths.config, 'utf8'), before);
  assert.equal(s.env.CLIVE_MY_LLM_API_KEY, undefined);
});

test('モデルの道具から届かない: 道具の一覧に、鍵・環境変数・プロバイダの設定を触るものが無い', async t => {
  const s = await start(t);
  const names = builtinTools().map(tool => tool.name);
  assert.equal(names.length, 24, '道具は増えていない');
  assert.deepEqual(names.filter(n => /key|env|provider|secret|credential|settings/iu.test(n)), []);
  for (const kind of ['chat', 'task', 'review'] as const) assert.deepEqual(s.app.tools.forRun(kind).map(tool => tool.name).filter(n => /key|env|provider/iu.test(n)), [], kind);
});

test('鍵の名前としてふさわしくない環境変数名（PATH・NODE_OPTIONS など）には書かない: 409 で、.env も環境も変えない', async t => {
  const s = await start(t, {}, c => {
    c.providers.push({ id: 'bad', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:3/v1', apiKeyEnv: 'NODE_OPTIONS', maxParallel: 1, timeoutMs: 10_000 });
  });
  const res = await s.put('bad', { key: '--require ./evil.js' });
  assert.equal(res.status, 409);
  assert.equal(existsSync(s.paths.env), false);
  assert.equal(s.env.NODE_OPTIONS, undefined);
  assert.equal(JSON.stringify(res.body).includes('evil'), false);
});

test('設定が通らない形になるなら（この PC の外への http に鍵）、.env を書く前に 400 で止める', async t => {
  const s = await start(t, {}, c => {
    c.providers.push({ id: 'remote', kind: 'openai_compatible', baseUrl: 'http://example.com/v1', maxParallel: 1, timeoutMs: 10_000 });
  });
  const config = readFileSync(s.paths.config, 'utf8');
  const res = await s.put('remote', { key: KEY });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_config');
  assert.equal(existsSync(s.paths.env), false, '.env を書かない');
  assert.equal(readFileSync(s.paths.config, 'utf8'), config);
  assert.equal(s.env.CLIVE_REMOTE_API_KEY, undefined);
  assert.equal(JSON.stringify(res.body).includes(KEY), false);
});

test('二つ同時に入れても、両方の行と両方の apiKeyEnv が残る（片方が巻き戻らない）', async t => {
  const s = await start(t);
  const [a, b] = await Promise.all([s.put('my-llm', { key: KEY }), s.put('other', { key: KEY2 })]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  const env = readFileSync(s.paths.env, 'utf8');
  assert.match(env, new RegExp(`CLIVE_MY_LLM_API_KEY=${KEY}\\n`, 'u'));
  assert.match(env, new RegExp(`CLIVE_OTHER_API_KEY=${KEY2}\\n`, 'u'));
  const providers = s.app.config().providers;
  assert.equal(providers.find(p => p.id === 'my-llm')!.apiKeyEnv, 'CLIVE_MY_LLM_API_KEY');
  assert.equal(providers.find(p => p.id === 'other')!.apiKeyEnv, 'CLIVE_OTHER_API_KEY');
});

test('同じ環境変数名を使うプロバイダが別にいれば、作る名前は重ならない（片方の鍵を上書きしない）', async t => {
  const s = await start(t, {}, c => {
    c.providers.push({ id: 'a-b', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:4/v1', maxParallel: 1, timeoutMs: 10_000 });
    c.providers.push({ id: 'a_b', kind: 'openai_compatible', baseUrl: 'http://127.0.0.1:5/v1', maxParallel: 1, timeoutMs: 10_000 });
  });
  assert.equal((await s.put('a-b', { key: KEY })).status, 200);
  assert.equal((await s.put('a_b', { key: KEY2 })).status, 200);
  const providers = s.app.config().providers;
  assert.equal(providers.find(p => p.id === 'a-b')!.apiKeyEnv, 'CLIVE_A_B_API_KEY');
  assert.equal(providers.find(p => p.id === 'a_b')!.apiKeyEnv, 'CLIVE_A_B_API_KEY_2');
  assert.equal(s.env.CLIVE_A_B_API_KEY, KEY);
  assert.equal(s.env.CLIVE_A_B_API_KEY_2, KEY2);
});

test('Linux: 作った .env は 0600', { skip: process.platform === 'win32' }, async t => {
  const s = await start(t);
  await s.put('my-llm', { key: KEY });
  assert.equal(statSync(s.paths.env).mode & 0o777, 0o600);
  await waitFor(() => true);
});

test('相手のサーバーが鍵をそのまま返してきても（エラーの本文・失敗の文に鍵が入っていても）、実行の記録・モデルの確認・ログ・出来事に残さない', async t => {
  const s = await start(t);
  await s.put('fake', { key: KEY });
  const events: string[] = [];
  t.after(s.app.bus.subscribe(e => events.push(JSON.stringify(e))));
  const echoed = () => fail(classifyHttpFailure(401, `Invalid API key: ${KEY}`));
  s.adapter().scripts.push(echoed(), echoed());
  s.adapters.get('my-llm')!.scripts.push(echoed());
  const outcome = s.app.engine.send('c1', 'hi');
  assert.ok(outcome.ok);
  await s.app.engine.wait(outcome.runId);
  const row = s.app.runs.get(outcome.runId)!;
  assert.match(row.error_message ?? '', /Invalid API key/u, '前提: 相手の本文は実行の記録に残る');
  assert.equal((row.error_message ?? '').includes(KEY), false, '実行の記録');
  s.adapter().probe = async () => { throw new Error(`connect failed with ${KEY}`); };
  await s.app.status.probeAll(s.app.config());
  assert.match(s.app.status.get('m1')!.message, /connect failed/u, '前提: 失敗の文は出る');
  assert.deepEqual(await whereIs(s, KEY, [JSON.stringify(s.app.status.all()), ...events]), []);
});
