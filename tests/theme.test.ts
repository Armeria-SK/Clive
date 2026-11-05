import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { getEffectiveTheme, getThemeMode, initTheme, setThemeMode, subscribeTheme, toggleTheme } from '../web/src/theme.ts';

const initScript = readFileSync(new URL('../web/public/theme-init.js', import.meta.url), 'utf8');

function makeEnv(init: { stored?: string; prefersDark: boolean; storageThrows?: boolean; noMatchMedia?: boolean; legacyQuery?: boolean }) {
  const store = new Map<string, string>();
  if (init.stored !== undefined) store.set('clive.theme', init.stored);
  const listeners: Array<() => void> = [];
  const query: { matches: boolean; addEventListener?: (type: string, fn: () => void) => void; addListener?: (fn: () => void) => void } = { matches: init.prefersDark };
  if (init.legacyQuery) query.addListener = fn => { listeners.push(fn); };
  else query.addEventListener = (_type, fn) => { listeners.push(fn); };
  const dataset: Record<string, string> = {};
  const localStorage = {
    getItem: (k: string) => { if (init.storageThrows) throw new Error('blocked'); return store.get(k) ?? null; },
    setItem: (k: string, v: string) => { if (init.storageThrows) throw new Error('blocked'); store.set(k, v); },
  };
  const matchMedia = (q: string) => { assert.equal(q, '(prefers-color-scheme: dark)'); return query; };
  return {
    store, dataset, localStorage, query,
    document: { documentElement: { dataset } },
    ...(init.noMatchMedia ? {} : { matchMedia }),
    window: init.noMatchMedia ? {} : { matchMedia },
    setOsDark: (dark: boolean) => { query.matches = dark; for (const fn of listeners) fn(); },
  };
}
type Env = ReturnType<typeof makeEnv>;

function runInit(env: Env): string | undefined {
  runInNewContext(initScript, { document: env.document, localStorage: env.localStorage, matchMedia: env.matchMedia });
  return env.dataset.theme;
}

function withGlobals<T>(env: Env, fn: () => T): T {
  const names = ['window', 'document', 'localStorage'] as const;
  const saved = names.map(n => [n, Object.getOwnPropertyDescriptor(globalThis, n)] as const);
  for (const n of names) Object.defineProperty(globalThis, n, { value: env[n], configurable: true, writable: true });
  try { return fn(); } finally {
    for (const [n, d] of saved) { if (d) Object.defineProperty(globalThis, n, d); else delete (globalThis as Record<string, unknown>)[n]; }
  }
}

test('theme-init.js: 保存した値が最優先で、無ければ OS の設定に従う', () => {
  assert.equal(runInit(makeEnv({ stored: 'dark', prefersDark: false })), 'dark');
  assert.equal(runInit(makeEnv({ stored: 'light', prefersDark: true })), 'light');
  assert.equal(runInit(makeEnv({ prefersDark: true })), 'dark');
  assert.equal(runInit(makeEnv({ prefersDark: false })), 'light');
  assert.equal(runInit(makeEnv({ stored: 'auto', prefersDark: true })), 'dark');
  assert.equal(runInit(makeEnv({ stored: 'auto', prefersDark: false })), 'light');
  assert.equal(runInit(makeEnv({ stored: 'blue', prefersDark: true })), 'dark', '知らない値は auto 扱い');
});

test('theme-init.js: 保存先が読めなくても、matchMedia が無くても落ちない', () => {
  assert.equal(runInit(makeEnv({ storageThrows: true, prefersDark: true })), 'dark');
  assert.equal(runInit(makeEnv({ prefersDark: true, noMatchMedia: true })), 'light');
});

test('theme.ts: 切り替えは data-theme と保存に反映され、theme-init.js が同じ値を読む', () => {
  const env = makeEnv({ prefersDark: false });
  withGlobals(env, () => {
    initTheme();
    assert.equal(getThemeMode(), 'auto');
    setThemeMode('dark');
    assert.equal(env.dataset.theme, 'dark');
    assert.equal(getThemeMode(), 'dark');
    assert.equal(env.store.get('clive.theme'), 'dark');
  });
  const reloaded = makeEnv({ prefersDark: false });
  reloaded.store.set('clive.theme', env.store.get('clive.theme')!);
  assert.equal(runInit(reloaded), 'dark', '再読み込みの最初の描画でも同じテーマ');
});

test('theme.ts: auto のときだけ OS の変化に追従する', () => {
  const env = makeEnv({ prefersDark: false });
  withGlobals(env, () => {
    initTheme();
    assert.equal(env.dataset.theme, 'light');
    env.setOsDark(true);
    assert.equal(env.dataset.theme, 'dark', 'auto は OS に追従');
    setThemeMode('light');
    env.setOsDark(false);
    env.setOsDark(true);
    assert.equal(env.dataset.theme, 'light', '明示した値は OS が変わっても動かない');
    setThemeMode('auto');
    assert.equal(env.dataset.theme, 'dark', 'auto に戻すと OS に従う');
  });
});

test('theme.ts: 起動時に保存した値を読み、保存先が使えなくても切り替えは画面に効く', () => {
  const saved = makeEnv({ stored: 'dark', prefersDark: false });
  withGlobals(saved, () => {
    initTheme();
    assert.equal(getThemeMode(), 'dark');
    assert.equal(saved.dataset.theme, 'dark');
  });
  const blocked = makeEnv({ prefersDark: false, storageThrows: true });
  withGlobals(blocked, () => {
    initTheme();
    assert.equal(getThemeMode(), 'auto');
    setThemeMode('dark');
    assert.equal(blocked.dataset.theme, 'dark');
    assert.equal(getThemeMode(), 'dark');
  });
});

test('theme.ts: window.matchMedia が無い環境でも落ちず、ライトで始まる（保存した値は効く）', () => {
  const plain = makeEnv({ prefersDark: true, noMatchMedia: true });
  withGlobals(plain, () => {
    initTheme();
    assert.equal(plain.dataset.theme, 'light');
    setThemeMode('dark');
    assert.equal(plain.dataset.theme, 'dark');
    setThemeMode('auto');
    assert.equal(plain.dataset.theme, 'light');
  });
  const saved = makeEnv({ stored: 'dark', prefersDark: false, noMatchMedia: true });
  withGlobals(saved, () => {
    initTheme();
    assert.equal(saved.dataset.theme, 'dark');
  });
});

test('theme.ts: addEventListener が無い古い MediaQueryList（addListener だけ）でも落ちず、OS の変化に追従する', () => {
  const env = makeEnv({ prefersDark: false, legacyQuery: true });
  withGlobals(env, () => {
    initTheme();
    assert.equal(env.dataset.theme, 'light');
    env.setOsDark(true);
    assert.equal(env.dataset.theme, 'dark');
    setThemeMode('light');
    env.setOsDark(false);
    env.setOsDark(true);
    assert.equal(env.dataset.theme, 'light');
  });
});

test('theme.ts: 今のテーマ（auto なら OS の結果）を返し、変わるたびに購読者へ知らせ、toggleTheme は明るい/暗いを入れ替えて保存する', () => {
  const env = makeEnv({ prefersDark: true });
  withGlobals(env, () => {
    initTheme();
    assert.equal(getThemeMode(), 'auto');
    assert.equal(getEffectiveTheme(), 'dark', 'auto は OS の結果');
    let calls = 0;
    const off = subscribeTheme(() => { calls += 1; });
    toggleTheme();
    assert.equal(getEffectiveTheme(), 'light');
    assert.equal(getThemeMode(), 'light', '押した結果は明示した値として残る');
    assert.equal(env.store.get('clive.theme'), 'light');
    assert.equal(env.dataset.theme, 'light');
    toggleTheme();
    assert.equal(getEffectiveTheme(), 'dark');
    assert.equal(calls, 2);
    setThemeMode('auto');
    env.setOsDark(false);
    assert.equal(getEffectiveTheme(), 'light', 'auto のあいだは OS の変化も購読者に届く');
    assert.ok(calls >= 4);
    off();
    const before = calls;
    toggleTheme();
    assert.equal(calls, before, '購読をやめたら知らせない');
  });
});
