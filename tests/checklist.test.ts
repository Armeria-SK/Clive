import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDatabase } from '../src/db/database.ts';
import { KV } from '../src/db/kv.ts';
import { MIGRATIONS } from '../src/db/migrations.ts';
import {
  checklistKey,
  checklistSection,
  readChecklist,
  writeChecklist,
  type ChecklistItem,
} from '../src/tools/builtin/checklist-core.ts';

const kv = () => new KV(openDatabase(':memory:', MIGRATIONS));

const items = (n: number): ChecklistItem[] => Array.from({ length: n }, (_, i) => ({ text: `task ${i + 1}`, status: 'pending' as const }));

test('キーは会話IDをそのまま使う', () => {
  assert.equal(checklistKey('c1'), 'checklist:c1');
});

test('書いて読んだら同じ', () => {
  const store = kv();
  const written = writeChecklist(store, 'c1', items(3), false, 1000);
  assert.deepEqual(written, { items: items(3), tainted: false, updatedAt: 1000 });
  assert.deepEqual(readChecklist(store, 'c1'), written);
});

test('空の並びで書いたら消える', () => {
  const store = kv();
  assert.notEqual(writeChecklist(store, 'c1', items(2), false, 1000), undefined);
  assert.equal(writeChecklist(store, 'c1', [], false, 1000), undefined);
  assert.equal(store.get('checklist:c1'), undefined);
  assert.equal(readChecklist(store, 'c1'), undefined);
  assert.equal(writeChecklist(store, 'c1', [{ text: '   ', status: 'pending' }], false, 1000), undefined);
  assert.equal(store.get('checklist:c1'), undefined);
});

test('改行と向きを変える文字が掃除される', () => {
  const store = kv();
  const written = writeChecklist(store, 'c1', [{ text: 'a\nb‮c', status: 'pending' }], false, 1000);
  assert.equal(written?.items[0]?.text, 'a bc');
  assert.equal(readChecklist(store, 'c1')?.items[0]?.text, 'a bc');
});

test('31個渡したら30個になる', () => {
  const store = kv();
  const written = writeChecklist(store, 'c1', items(31), false, 1000);
  assert.equal(written?.items.length, 30);
  assert.equal(readChecklist(store, 'c1')?.items.length, 30);
});

test('壊れた値は無いものとして扱う', () => {
  const store = kv();
  store.set('checklist:c1', '{');
  assert.equal(readChecklist(store, 'c1'), undefined);
  store.setJson('checklist:c1', { items: [{ text: 1 }] });
  assert.equal(readChecklist(store, 'c1'), undefined);
});

test('全部doneなら文は空', () => {
  const done: ChecklistItem[] = [{ text: 'task 1', status: 'done' }];
  assert.equal(checklistSection({ items: done, tainted: false, updatedAt: 1 }, 'ja'), '');
  assert.equal(checklistSection(undefined, 'ja'), '');
});

test('pendingとin_progressが出てdoneは出ない', () => {
  const section = checklistSection({
    items: [
      { text: 'task 1', status: 'pending' },
      { text: 'task 2', status: 'in_progress' },
      { text: 'task 3', status: 'done' },
    ],
    tainted: false,
    updatedAt: 1,
  }, 'ja');
  assert.match(section, /^作業の一覧/);
  assert.match(section, /- \[ \] task 1/);
  assert.match(section, /- \[>\] task 2/);
  assert.doesNotMatch(section, /task 3/);
});

test('taintedなら汚染の文が入る', () => {
  const section = checklistSection({
    items: [{ text: 'task 1', status: 'pending' }],
    tainted: true,
    updatedAt: 1,
  }, 'ja');
  assert.match(section, /よそから来た文を読んだあとに書かれました/);
});

test('英語の文に日本語の文字が入らない', () => {
  const section = checklistSection({
    items: [
      { text: 'task one', status: 'pending' },
      { text: 'task two', status: 'in_progress' },
    ],
    tainted: true,
    updatedAt: 1,
  }, 'en');
  assert.doesNotMatch(section, /[぀-ヿ一-鿿]/u);
});
