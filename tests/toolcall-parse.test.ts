import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractToolCalls, looksLikeTextToolCall, toJsonFallbackHistory } from '../src/engine/toolcall-parse.ts';
import type { ChatMessage } from '../src/engine/types.ts';

const names = new Set(['file_write', 'shell_run']);

test('予備パーサー: Qwen / Hermes の <tool_call>', () => {
  const r = extractToolCalls('書きます。\n<tool_call>\n{"name": "file_write", "arguments": {"path": "a.md", "content": "x"}}\n</tool_call>', names);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.calls[0]!.arguments, { path: 'a.md', content: 'x' });
  assert.equal(r.text, '書きます。');
});

test('予備パーサー: Mistral の [TOOL_CALLS]、コードブロック、本文全体の JSON、arguments が文字列の場合', () => {
  assert.equal(extractToolCalls('[TOOL_CALLS] [{"name": "shell_run", "arguments": {"command": "ls"}}]', names).calls[0]!.name, 'shell_run');
  assert.equal(extractToolCalls('```json\n{"name": "shell_run", "parameters": {"command": "ls"}}\n```', names).calls.length, 1);
  assert.equal(extractToolCalls('{"name": "shell_run", "arguments": "{\\"command\\": \\"ls\\"}"}', names).calls[0]!.arguments instanceof Object, true);
  const broken = extractToolCalls('<tool_call>{"name": "shell_run", "arguments": "{bad"}</tool_call>', names);
  assert.equal(broken.calls[0]!.arguments, undefined, '壊れた引数は undefined にして、パイプラインで直させる');
});

test('予備パーサー: 知らないツール名や普通の JSON は拾わない', () => {
  assert.equal(extractToolCalls('<tool_call>{"name": "rm_rf", "arguments": {}}</tool_call>', names).calls.length, 0);
  assert.equal(extractToolCalls('設定はこうです: {"name": "Clive", "age": 1}', names).calls.length, 0);
  assert.equal(looksLikeTextToolCall('普通の返事'), false);
  assert.equal(looksLikeTextToolCall('<tool_call>{}</tool_call>'), true);
});

test('json_fallback: 履歴のツール呼び出しと結果をテキストに直す', () => {
  const history = toJsonFallbackHistory([
    { role: 'user', content: 'やって' },
    { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'shell_run', arguments: { command: 'ls' } }] },
    { role: 'tool', toolCallId: '1', name: 'shell_run', content: 'a.md' },
  ]);
  assert.deepEqual(history.map(m => m.role), ['user', 'assistant', 'user']);
  assert.match((history[1] as { content: string }).content, /<tool_call>/u);
  assert.match((history[2] as { content: string }).content, /shell_run」の結果/u);
});

// ── 段 4-4: 道具の結果の画像は、本文で道具を呼ぶモデルには、道具の結果をまとめた利用者の発言の images に移す ──

const png = (data: string) => ({ mediaType: 'image/png', data });

test('json_fallback: 道具の結果の画像は、まとめた利用者の発言の images に移る（続く道具の結果の画像は順番どおりに足される）', () => {
  const history = toJsonFallbackHistory([
    { role: 'user', content: '画像を見て' },
    { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'image_view', arguments: { path: 'a.png' } }, { id: '2', name: 'image_view', arguments: { path: 'b.png' } }] },
    { role: 'tool', toolCallId: '1', name: 'image_view', content: 'a.png です', images: [png('A')] },
    { role: 'tool', toolCallId: '2', name: 'image_view', content: 'b.png です', images: [png('B1'), png('B2')] },
  ]);
  assert.deepEqual(history.map(m => m.role), ['user', 'assistant', 'user'], '道具の結果は 1 つの利用者の発言にまとまる');
  const merged = history[2] as Extract<ChatMessage, { role: 'user' }>;
  assert.deepEqual(merged.images?.map(i => i.data), ['A', 'B1', 'B2']);
  assert.ok(merged.content.includes('a.png です') && merged.content.includes('b.png です'), '文字は今までどおりまとまる');
});

test('json_fallback: 道具の結果が利用者の発言の直後に続くとき、その発言の画像のあとに足す。入力の発言は書き換えない', () => {
  const input: ChatMessage[] = [
    { role: 'user', content: '見て', images: [png('USER')] },
    { role: 'tool', toolCallId: '1', name: 'image_view', content: 'a.png です', images: [png('TOOL')] },
  ];
  const before = JSON.stringify(input);
  const history = toJsonFallbackHistory(input);
  assert.deepEqual(history.map(m => m.role), ['user']);
  assert.deepEqual((history[0] as Extract<ChatMessage, { role: 'user' }>).images?.map(i => i.data), ['USER', 'TOOL']);
  assert.equal(JSON.stringify(input), before, '入力の発言（画像の並びも）は書き換えない');
});

test('json_fallback: 画像の無い道具の結果は今までと同じ（images の項目が付かない。前の発言の画像はそのまま）', () => {
  const history = toJsonFallbackHistory([
    { role: 'user', content: '見て', images: [png('USER')] },
    { role: 'tool', toolCallId: '1', name: 'file_read', content: 'a' },
    { role: 'assistant', content: '', toolCalls: [{ id: '2', name: 'file_read', arguments: {} }] },
    { role: 'tool', toolCallId: '2', name: 'file_read', content: 'b', images: [] },
  ]);
  assert.deepEqual(history.map(m => m.role), ['user', 'assistant', 'user']);
  assert.deepEqual((history[0] as Extract<ChatMessage, { role: 'user' }>).images?.map(i => i.data), ['USER']);
  assert.equal('images' in history[2]!, false, '画像が無い（空の並びも）なら、項目を付けない');
});
