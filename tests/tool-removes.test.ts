import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { builtinTools } from '../src/app.ts';
import { parseConfig } from '../src/config/store.ts';
import { resolvePaths } from '../src/paths.ts';
import { fileEdit, fileWrite } from '../src/tools/builtin/files.ts';
import { memoryForget, memorySave, memoryUpdate } from '../src/tools/builtin/memory.ts';
import { tableWrite } from '../src/tools/builtin/tables.ts';
import { buildPolicy, defaultWorkspace } from '../src/tools/policy.ts';
import type { ToolContext } from '../src/tools/types.ts';
import { tempDir, testConfig } from './helpers.ts';

function setup(t: { after: (fn: () => void) => void }) {
  const paths = resolvePaths(tempDir(t));
  mkdirSync(paths.workspace, { recursive: true });
  writeFileSync(join(paths.workspace, 'a.txt'), 'x');
  writeFileSync(join(paths.workspace, 'empty.txt'), '');
  writeFileSync(join(paths.workspace, 't.csv'), 'a\n');
  const config = testConfig();
  config.tools.roots = [{ path: 'workspace', mode: 'write' }];
  const parsed = parseConfig(config);
  const policy = buildPolicy(parsed, paths);
  const ctx: ToolContext = {
    runId: 'r1', conversationId: 'c1', kind: 'chat', signal: new AbortController().signal, config: parsed, paths, policy,
    workspace: defaultWorkspace(policy, paths), taint: { tainted: false, sources: [] }, log: () => undefined,
  };
  return { ctx };
}

test('file_write / file_edit / table_write say sends: false and removes: false, also when they overwrite an existing file (overwriting is not a removal)', async t => {
  const { ctx } = setup(t);
  const calls: Array<[string, () => ReturnType<NonNullable<typeof fileWrite.preCheck>>]> = [
    ['file_write overwrite (default) on a file with content', () => fileWrite.preCheck!({ path: 'a.txt', content: 'y' }, ctx)],
    ['file_write overwrite on an empty file', () => fileWrite.preCheck!({ path: 'empty.txt', content: 'y', mode: 'overwrite' }, ctx)],
    ['file_write append', () => fileWrite.preCheck!({ path: 'a.txt', content: 'y', mode: 'append' }, ctx)],
    ['file_write create', () => fileWrite.preCheck!({ path: 'a.txt', content: 'y', mode: 'create' }, ctx)],
    ['file_write a new file', () => fileWrite.preCheck!({ path: 'new.txt', content: 'y' }, ctx)],
    ['file_edit', () => fileEdit.preCheck!({ path: 'a.txt', old: 'x', new: 'y' }, ctx)],
    ['file_edit all', () => fileEdit.preCheck!({ path: 'a.txt', old: 'x', new: 'y', all: true }, ctx)],
    ['table_write overwrite: true on an existing table', () => tableWrite.preCheck!({ path: 't.csv', rows: [['a']], overwrite: true }, ctx)],
    ['table_write a new table', () => tableWrite.preCheck!({ path: 'new.csv', rows: [['a']] }, ctx)],
  ];
  for (const [label, run] of calls) {
    const pre = await run();
    assert.equal(pre.decision, 'allow', `${label}: decision`);
    assert.equal(pre.removes, false, `${label}: removes must be said as false, not left out`);
    assert.equal(pre.sends, false, `${label}: sends must be said as false, not left out (a write tool that says nothing counts as sending)`);
  }
});

test('memory_forget is the only builtin tool that removes whatever its input; memory_save / memory_update do not', () => {
  assert.equal(memoryForget.removes, true);
  assert.equal(memorySave.removes, undefined);
  assert.equal(memoryUpdate.removes, undefined);
  assert.deepEqual(builtinTools().filter(tool => tool.removes).map(tool => tool.name), ['memory_forget']);
});

test('every builtin tool with effect write or exec is known here: a new one has to decide what it says about sends and removes', () => {
  const effectful = builtinTools().filter(tool => tool.effect === 'write' || tool.effect === 'exec').map(tool => tool.name).sort();
  assert.deepEqual(effectful, ['file_edit', 'file_write', 'shell_run', 'table_write']);
});
