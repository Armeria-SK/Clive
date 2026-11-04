import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractToolCalls, looksLikeTextToolCall, toJsonFallbackHistory } from '../src/engine/toolcall-parse.ts';

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
