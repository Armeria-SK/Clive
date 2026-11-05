import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { evaluateContext, errorProbeText } from '../src/providers/context.ts';
import { providerError } from '../src/providers/types.ts';
import { engineText } from '../src/shared/messages/engine.ts';
import { httpText } from '../src/shared/messages/http.ts';
import { providerText } from '../src/shared/messages/providers.ts';
import { storeText } from '../src/shared/messages/stores.ts';
import { taskText } from '../src/shared/messages/tasks.ts';
import { ApiError } from '../web/src/api.ts';
import { setLanguagePreference } from '../web/src/i18n/index.ts';
import { classifyHttpFailure } from '../src/providers/http.ts';
import { errorBodyText, probeMessage, serverText, warningText } from '../web/src/server-text.ts';
import { startScreenServer } from './screen-server.ts';

afterEach(() => setLanguagePreference('auto'));

test('コードの訳: 画面の言語の文になり、サーバーが同じ言語で書く文と同じになる（領域ごと）', () => {
  for (const language of ['ja', 'en'] as const) {
    assert.equal(serverText('http.required', { field: 'title' }, language), httpText(language, 'required', { field: 'title' }));
    assert.equal(serverText('http.too_long', { field: 'body', max: 600 }, language), httpText(language, 'too_long', { field: 'body', max: 600 }));
    assert.equal(serverText('task.error.not_found', { id: 'abc' }, language), taskText(language, 'error.not_found', { id: 'abc' }));
    assert.equal(serverText('store.memory.duplicate', { ref: '[u3]' }, language), storeText(language, 'memory.duplicate', { ref: '[u3]' }));
    assert.equal(serverText('provider.key.missing', { env: 'OPENAI_API_KEY' }, language), providerText(language, 'key.missing', { env: 'OPENAI_API_KEY' }));
    assert.equal(serverText('engine.run.no_provider', { id: 'x' }, language), engineText(language, 'run.no_provider', { id: 'x' }));
    assert.equal(serverText('http.internal', undefined, language), httpText(language, 'internal'));
  }
  assert.notEqual(serverText('http.required', { field: 'title' }, 'en'), serverText('http.required', { field: 'title' }, 'ja'), '言語ごとに別の文');
  assert.match(serverText('http.required', { field: 'title' }, 'en')!, /title/u);
});

test('コードの訳: 表に無い・コードの形でない・差し込みの値が足りないときは null（サーバーの文をそのまま出す）', () => {
  assert.equal(serverText(undefined, {}, 'en'), null);
  assert.equal(serverText(null, {}, 'en'), null);
  assert.equal(serverText('', {}, 'en'), null);
  assert.equal(serverText('nodot', {}, 'en'), null);
  assert.equal(serverText('.leading', {}, 'en'), null);
  assert.equal(serverText('mystery.code', {}, 'en'), null, '知らない領域');
  assert.equal(serverText('http.mystery', {}, 'en'), null, '知らないキー');
  assert.equal(serverText('http.required', {}, 'en'), null, '{field} が足りない');
  assert.equal(serverText('http.required', { field: 'x', extra: 1 }, 'en'), httpText('en', 'required', { field: 'x' }), '余分な値は無視');
  assert.equal(serverText('engine.no_usable', {}, 'en'), null, '{lines} が足りない（コードに値の無いもの）は、サーバーの文のまま');
  assert.equal(serverText('http.required', { field: { nested: true } } as never, 'en'), null, '入れ子の値は差し込まない');
});

const TRACEBACK = 'Traceback (most recent call last):\n  File "/app/server.py", line 88, in handle\n    raise ValueError("bad request " + payload)\nValueError: bad request ' + 'x'.repeat(400);

test('返事の失敗の札: 相手のサーバーが返した本文（Python の traceback など）は、どの言語でも、画面に出す文に入らない（短い文だけ）', () => {
  const failure = classifyHttpFailure(400, TRACEBACK);
  assert.doesNotMatch(failure.message, /Traceback|server\.py|ValueError/u, 'サーバーが作る文にも本文は入らない');
  for (const language of ['ja', 'en'] as const) {
    const shown = serverText(`provider.${failure.code}`, failure.params, language)!;
    assert.equal(shown, providerText(language, 'http.rejected', { status: 400 }), `${language}: 「リクエストが拒否されました」だけ`);
    assert.doesNotMatch(shown, /Traceback|server\.py|ValueError/u);
  }
  // 古いサーバーが送った値（suffix に本文が入っている）が届いても、画面の文に本文は出ない
  for (const language of ['ja', 'en'] as const) {
    const old = serverText('provider.http.rejected', { status: 400, suffix: `: ${TRACEBACK}` }, language)!;
    assert.equal(old, providerText(language, 'http.rejected', { status: 400 }));
  }
  for (const [status, code] of [[401, 'http.auth'], [404, 'http.not_found'], [429, 'http.rate_limit'], [500, 'http.server'], [400, 'http.rejected']] as const) {
    const error = classifyHttpFailure(status, TRACEBACK);
    assert.equal(error.code, code);
    const shown = serverText(`provider.${error.code}`, error.params, 'ja')!;
    assert.doesNotMatch(shown, /Traceback|ValueError/u, code);
    assert.ok(shown.includes('HTTP'), `${code}: 状態の番号は残る`);
  }
  assert.equal(serverText('provider.timeout', {}, 'ja'), providerText('ja', 'timeout'), '本文の無い失敗は今までどおり');
  assert.equal(serverText('provider.mystery', {}, 'ja'), null, '知らないコードは null（呼ぶ側がサーバーの文を使う）');
});

test('API のエラーの本文: code / params と、返事の 409 の errorCode / errorParams を読む。コードが無ければ null', () => {
  assert.equal(errorBodyText({ error: 'invalid_field', field: 'title', message: '日本語の文', code: 'http.required', params: { field: 'title' } }, 'en'), httpText('en', 'required', { field: 'title' }));
  assert.equal(errorBodyText({ errorKind: 'busy', errorMessage: '日本語の文', errorCode: 'engine.send.busy' }, 'en'), engineText('en', 'send.busy'));
  assert.equal(errorBodyText({ errorKind: 'internal', errorMessage: '日本語の文', errorCode: 'engine.run.no_provider', errorParams: { id: 'x' } }, 'en'), engineText('en', 'run.no_provider', { id: 'x' }), 'errorParams を読む');
  assert.equal(errorBodyText({ error: 'invalid_field', message: '日本語の文' }, 'en'), null);
  assert.equal(errorBodyText(null, 'en'), null);
  assert.equal(errorBodyText('text', 'en'), null);
  assert.equal(errorBodyText({ code: 'http.mystery', message: 'm' }, 'en'), null);
});

test('API のエラーを本物のサーバーから受けて、画面の言語に訳す（言語がサーバーと画面で違っても）', async t => {
  const { api } = await startScreenServer(t);
  const post = async (path: string, body: unknown) => {
    const res = await api(path, { method: 'POST', body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  const missing = await post('/api/memories', { book: 'user' });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, 'http.required');
  assert.deepEqual(missing.body.params, { field: 'content' });
  assert.equal(errorBodyText(missing.body, 'en'), httpText('en', 'required', { field: 'content' }));
  assert.equal(errorBodyText(missing.body, 'ja'), httpText('ja', 'required', { field: 'content' }));

  const badBook = await post('/api/memories', { book: 'x', content: 'a' });
  assert.equal(errorBodyText(badBook.body, 'en'), httpText('en', 'bad_book'));

  const gone = await api('/api/memories/999', { method: 'DELETE' });
  const goneBody = await gone.json() as Record<string, unknown>;
  assert.equal(goneBody.code, 'store.memory.not_found');
  assert.deepEqual(goneBody.params, { id: 999 });
  assert.equal(errorBodyText(goneBody, 'en'), storeText('en', 'memory.not_found', { id: 999 }));
  assert.notEqual(errorBodyText(goneBody, 'en'), goneBody.message, 'サーバーは ja で書いているので、en の画面では別の文になる');

  const noEvent = await post('/api/memory-events/999/undo', {});
  assert.equal(noEvent.body.code, 'store.memory.no_event');
  assert.equal(errorBodyText(noEvent.body, 'en'), storeText('en', 'memory.no_event'));

  const badWhen = await post('/api/tasks', { title: 'x', when: 'nonsense' });
  assert.equal(badWhen.body.code, 'http.bad_when');
  assert.equal(errorBodyText(badWhen.body, 'en'), httpText('en', 'bad_when'));

  setLanguagePreference('en');
  const error = new ApiError(missing.status, missing.body);
  assert.equal(error.message, httpText('en', 'required', { field: 'content' }), 'ApiError の message は、画面の言語の文');
  assert.equal(error.body, missing.body, '本文はそのまま持つ');
  setLanguagePreference('ja');
  assert.equal(new ApiError(missing.status, missing.body).message, httpText('ja', 'required', { field: 'content' }));
});

test('ApiError: コードが無い・辞書に無いときは、サーバーの文のまま。errorMessage だけの本文も読む', () => {
  setLanguagePreference('en');
  assert.equal(new ApiError(404, { error: 'not_found', message: 'サーバーの文' }).message, 'サーバーの文');
  assert.equal(new ApiError(400, { code: 'http.future_code', message: '未来のコード' }).message, '未来のコード');
  assert.equal(new ApiError(409, { errorMessage: '詳しい文', errorKind: 'busy' }).message, '詳しい文');
  assert.equal(new ApiError(500, {}).message, 'HTTP 500');
  assert.equal(new ApiError(409, { errorMessage: 'x', errorCode: 'engine.send.busy_chat' }).message, engineText('en', 'send.busy_chat'));
});

test('警告: コードから画面の言語の文にする。再試行は理由のコード（無ければ詳しい文）をはめる。知らないコードはサーバーの文', () => {
  const cases: Array<[string, Record<string, string | number>, string, Record<string, string | number>]> = [
    ['max_iterations', { max: 16 }, 'warn.max_iterations', { max: 16 }],
    ['context_trimmed', { count: 4 }, 'warn.context_trimmed', { count: 4 }],
    ['partial_discarded', {}, 'warn.partial_discarded', {}],
    ['compacted', { count: 12 }, 'warn.compacted', { count: 12 }],
    ['compaction_failed', {}, 'warn.compaction_failed', {}],
    ['server_truncation_suspected', { actual: 900, estimate: 5000 }, 'warn.server_truncation', { actual: 900, estimate: 5000 }],
  ];
  for (const language of ['ja', 'en'] as const) {
    for (const [code, params, key, args] of cases) {
      assert.equal(warningText({ code, message: 'サーバーの文', params }, language), engineText(language, key as never, args), `${language} ${code}`);
    }
  }
  const error = providerError('rate_limit', 'http.rate_limit', { status: 429 });
  const secret = warningText({ code: 'retrying', message: 'サーバーの文', params: { seconds: 8, attempt: 2, retries: 3, errorCode: 'provider.http.server', errorParams: { status: 500, suffix: ': Traceback (most recent call last): boom' } } }, 'ja');
  assert.doesNotMatch(secret, /Traceback|boom/u, '再試行の知らせにも、相手の本文は出さない');
  assert.match(secret, /プロバイダ側のエラーです（HTTP 500）/u);
  const retryParams = { seconds: 8, attempt: 2, retries: 3, errorCode: 'provider.http.rate_limit', errorParams: error.params };
  for (const language of ['ja', 'en'] as const) {
    assert.equal(
      warningText({ code: 'retrying', message: 'サーバーの文', params: retryParams }, language),
      engineText(language, 'warn.retrying', { message: error.text(language), seconds: 8, attempt: 2, retries: 3 }),
    );
  }
  assert.equal(
    warningText({ code: 'retrying', message: 'サーバーの文', params: { seconds: 5, attempt: 1, retries: 2, detail: 'socket hang up' } }, 'en'),
    engineText('en', 'warn.retrying', { message: 'socket hang up', seconds: 5, attempt: 1, retries: 2 }),
    '理由のコードが無ければ詳しい文をはめる',
  );
  assert.equal(warningText({ code: 'retrying', message: 'サーバーの文', params: { seconds: 5 } }, 'en'), 'サーバーの文', '理由が無ければ、サーバーの文');
  assert.equal(warningText({ code: 'max_iterations', message: 'サーバーの文' }, 'en'), 'サーバーの文', '値が無ければサーバーの文');
  assert.equal(warningText({ code: 'something_new', message: 'サーバーの文', params: { a: 1 } }, 'en'), 'サーバーの文');
});

test('モデルの確認の説明: サーバーが作る probe の message を、コードと値から画面の言語で組み立て直すと、サーバーがその言語で書く文と同じ', () => {
  const facts = [
    { modelId: 'a', server: 'generic', required: 32768, declared: 65536, modelMax: 32000 },
    { modelId: 'b', server: 'generic', required: 32768 },
    { modelId: 'c', server: 'lmstudio', required: 32768, measured: 8192, declared: 65536 },
    { modelId: 'd', server: 'generic', required: 32768, declared: 8192 },
    { modelId: 'e', server: 'generic', required: 32768, modelMax: 4096 },
    { modelId: 'f', server: 'lmstudio', required: 32768, measured: 131072 },
    { modelId: 'g', server: 'generic', required: 32768, declared: 131072, unmeasuredNote: 'probe.note.use_config' as const },
    { modelId: 'h', server: 'ollama', required: 32768, declared: 65536, unmeasuredNote: 'probe.note.not_loaded' as const },
    { modelId: 'i', server: 'generic', required: 32768, declared: 65536, unmeasuredNote: 'probe.note.max_unavailable' as const },
  ];
  for (const fact of facts) {
    for (const from of ['ja', 'en'] as const) {
      const served = evaluateContext({ ...fact, language: from });
      for (const to of ['ja', 'en'] as const) {
        const expected = evaluateContext({ ...fact, language: to }).message;
        assert.equal(probeMessage(served, to), expected, `${fact.modelId}: ${from} で届いたものを ${to} で`);
      }
    }
  }
  const ja = evaluateContext({ ...facts[2]!, language: 'ja' });
  assert.notEqual(probeMessage(ja, 'en'), ja.message, '日本語で届いた説明が、英語の画面では英語になる');
});

test('モデルの確認の説明（接続などの失敗）: プロバイダのエラーのコードから、画面の言語で書く。コードが無ければサーバーの文', () => {
  const errors = [
    providerError('provider_error', 'probe.ollama_not_found', { model: 'qwen3:32b' }),
    providerError('provider_error', 'probe.ollama_unreachable', { base: 'http://127.0.0.1:11434' }),
    providerError('provider_error', 'probe.tabby_other', { current: 'a', model: 'b' }),
    providerError('provider_error', 'probe.check_failed', { detail: 'boom' }),
    providerError('auth', 'key.missing', { env: 'OPENAI_API_KEY' }),
  ];
  for (const error of errors) {
    const served = errorProbeText(error, 'ja');
    assert.equal(probeMessage({ message: served.message, messageCode: served.messageCode, messageParams: served.messageParams }, 'en'), error.text('en'), error.code);
  }
  assert.equal(probeMessage({ message: 'サーバーの文' }, 'en'), 'サーバーの文');
  assert.equal(probeMessage({ message: 'サーバーの文', messageCode: 'provider.probe.too_small', messageParams: { effective: '1' } }, 'en'), 'サーバーの文', '値が足りなければサーバーの文');
  assert.equal(probeMessage({ message: 'サーバーの文', messageCode: 'provider.probe.mystery' }, 'en'), 'サーバーの文');
});
