import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelView, WorkerStatus } from '../web/src/api.ts';
import { presenceOf } from '../web/src/avatar.ts';
import { approvalTargetHash, CONVERSATION_LIST_LIMIT, conversationCountLabel, convMark, isChatRun, type RunContext } from '../web/src/conversation-state.ts';
import { en } from '../web/src/i18n/en.ts';
import { formatElapsed, formatRelativeCompact, setLanguagePreference, setTimezone } from '../web/src/i18n/index.ts';
import { ja } from '../web/src/i18n/ja.ts';
import { closeTopLayer, ESC_ORDER, isComposing, modLabel, registerEscape, shortcutOf } from '../web/src/keys.ts';
import { layoutModeFor, loadPanelPreference, savePanelPreference } from '../web/src/layout.ts';
import { PAGE_META, pickChatModel, workerState } from '../web/src/pages.ts';
import { chatHash, parseRoute, routeHash } from '../web/src/routes.ts';
import { closeTab, dropChats, findGoneChats, loadTabs, MAX_TABS, openTab, sanitizeTabs, saveTabs, toTab, unlistedChatIds, type ChatProbe, type Tab } from '../web/src/tabs.ts';

const reset = () => { setLanguagePreference('ja'); setTimezone('Asia/Tokyo'); };
const keys = (tabs: Tab[]) => tabs.map(x => x.key);
const tab = (hash: string): Tab => toTab(hash)!;

test('parseRoute: 古い経路（通知のリンクに保存されているもの）も、今の画面へ転送し続ける', () => {
  assert.deepEqual(parseRoute('#/today'), { page: 'today' });
  assert.deepEqual(parseRoute('#/notifications'), { page: 'notifications' });
  assert.deepEqual(parseRoute('#/review'), { page: 'review' });
  assert.deepEqual(parseRoute('#/memory'), { page: 'memory' });
  assert.deepEqual(parseRoute('#/curiosity'), { page: 'curiosity' });
  assert.deepEqual(parseRoute('#/skills'), { page: 'skills' });
  assert.deepEqual(parseRoute('#/settings'), { page: 'settings' });
  assert.deepEqual(parseRoute('#/runs'), { page: 'runs' });
  assert.deepEqual(parseRoute('#/tasks'), { page: 'tasks', taskId: null });
  assert.deepEqual(parseRoute('#/tasks/abc%20d'), { page: 'tasks', taskId: 'abc d' });
  assert.deepEqual(parseRoute('#/c/xyz'), { page: 'chat', conversationId: 'xyz' });
  assert.deepEqual(parseRoute('#/'), { page: 'chat', conversationId: null });
  assert.deepEqual(parseRoute(''), { page: 'chat', conversationId: null });
  assert.deepEqual(parseRoute('#/nonsense'), { page: 'chat', conversationId: null });
  assert.deepEqual(parseRoute('#/c/%E0%A4%A'), { page: 'chat', conversationId: '%E0%A4%A' }, '壊れたエンコードでも落ちない');
});

test('routeHash / chatHash: 経路から正規のハッシュに戻せる', () => {
  for (const hash of ['#/', '#/c/a%2Fb', '#/tasks', '#/tasks/t1', '#/settings', '#/today', '#/review']) assert.equal(routeHash(parseRoute(hash)), hash);
  assert.equal(chatHash(null), '#/');
  assert.equal(chatHash('a b'), '#/c/a%20b');
  assert.equal(routeHash(parseRoute('#/settings/extra')), '#/settings', '正規の形にそろう');
});

test('toTab: 経路ごとに 1 つのタブ。きょう（右のパネル）はタブにしない', () => {
  assert.deepEqual(toTab('#/c/a'), { key: 'chat:a', hash: '#/c/a' });
  assert.deepEqual(toTab('#/'), { key: 'chat:new', hash: '#/' });
  assert.deepEqual(toTab('#/tasks/t9'), { key: 'tasks', hash: '#/tasks/t9' });
  assert.equal(toTab('#/today'), null);
  assert.deepEqual(toTab('#/xx'), { key: 'chat:new', hash: '#/' });
});

test('openTab: 会話から会話へは今のタブを置き換え、ページは並べて足し、すでにあるタブは行き先だけ更新する', () => {
  const start = [tab('#/c/a')];
  const second = openTab(start, '#/c/b', { activeKey: 'chat:a' });
  assert.deepEqual(keys(second), ['chat:b'], '会話のタブは置き換わる');
  const appended = openTab(start, '#/c/b', { activeKey: 'chat:a', append: true });
  assert.deepEqual(keys(appended), ['chat:a', 'chat:b'], '新しい会話は並べて足す');
  const page = openTab(second, '#/tasks', { activeKey: 'chat:b' });
  assert.deepEqual(keys(page), ['chat:b', 'tasks'], 'ページは並べて足す');
  const fromPage = openTab(page, '#/c/z', { activeKey: 'tasks' });
  assert.deepEqual(keys(fromPage), ['chat:b', 'tasks', 'chat:z'], 'ページからは置き換えない');
  const detail = openTab(page, '#/tasks/t1', { activeKey: 'tasks' });
  assert.deepEqual(detail.map(x => x.hash), ['#/c/b', '#/tasks/t1'], 'タスクのタブは詳細の行き先を覚える');
  assert.equal(openTab(detail, '#/tasks/t1', { activeKey: 'tasks' }), detail, '変わらなければ同じ配列を返す');
  assert.equal(openTab(page, '#/today', { activeKey: 'tasks' }), page, 'きょうは何もしない');
  const replacedNew = openTab([tab('#/')], '#/c/q', { activeKey: 'chat:new' });
  assert.deepEqual(keys(replacedNew), ['chat:q'], '空の新しい会話は、作った会話に置き換わる');
});

test('openTab: 上限を超えたら、今開いたもの以外の古いタブから落とす', () => {
  let tabs: Tab[] = [];
  for (let i = 0; i < MAX_TABS + 3; i += 1) tabs = openTab(tabs, `#/c/c${i}`, { activeKey: null, append: true });
  assert.equal(tabs.length, MAX_TABS);
  assert.equal(tabs.at(-1)!.key, `chat:c${MAX_TABS + 2}`);
  assert.equal(tabs[0]!.key, 'chat:c3');
});

test('closeTab: 開いているタブを閉じたら隣へ移り、全部閉じたら新しい会話に戻る', () => {
  const tabs = [tab('#/c/a'), tab('#/tasks'), tab('#/settings')];
  assert.equal(closeTab(tabs, 'tasks', 'tasks').go, '#/settings', '右隣へ');
  assert.equal(closeTab(tabs, 'settings', 'settings').go, '#/tasks', '右が無ければ左隣へ');
  const other = closeTab(tabs, 'tasks', 'chat:a');
  assert.equal(other.go, null, '今開いていないタブを閉じても移らない');
  assert.deepEqual(keys(other.tabs), ['chat:a', 'settings']);
  const last = closeTab([tab('#/tasks')], 'tasks', 'tasks');
  assert.equal(last.go, '#/');
  assert.deepEqual(keys(last.tabs), ['chat:new']);
  assert.equal(closeTab(tabs, 'nope', 'tasks').tabs, tabs);
});

test('unlistedChatIds / dropChats: 一覧に無い会話のタブは確かめる対象にするだけで、消えた会話のタブだけを閉じる', () => {
  const tabs = [tab('#/c/a'), tab('#/c/old'), tab('#/c/gone'), tab('#/'), tab('#/tasks')];
  assert.deepEqual(unlistedChatIds(tabs, new Set(['a']), null), ['old', 'gone'], '新しい会話・ページは対象にしない');
  assert.deepEqual(unlistedChatIds(tabs, new Set(['a']), 'chat:gone'), ['old'], '今開いているタブは対象にしない');
  assert.deepEqual(keys(dropChats(tabs, new Set(['gone']), null)), ['chat:a', 'chat:old', 'chat:new', 'tasks'], '404 だった会話だけ閉じる（一覧に無いだけの会話は残る）');
  assert.deepEqual(keys(dropChats(tabs, new Set(['gone']), 'chat:gone')), keys(tabs), '今開いているタブは閉じない');
  assert.equal(dropChats(tabs, new Set(), null), tabs);
});

test('findGoneChats: サーバーが無いと答えた（404）会話だけを返し、読めなかったときは消えたと見なさない', async () => {
  const verdicts: Record<string, ChatProbe> = { a: 'exists', b: 'gone', c: 'unknown' };
  const gone = await findGoneChats(['a', 'b', 'c', 'd'], async id => { if (id === 'd') throw new Error('network'); return verdicts[id]!; });
  assert.deepEqual([...gone], ['b']);
  assert.deepEqual([...(await findGoneChats([], async () => 'gone'))], []);
});

test('sanitizeTabs: 壊れた保存値を落とす', () => {
  assert.deepEqual(sanitizeTabs(['#/tasks', '#/tasks/x', 5, null, '#/today', '#/c/a']).map(x => x.hash), ['#/tasks', '#/c/a'], '重複・文字列でないもの・きょうは捨てる');
  assert.deepEqual(sanitizeTabs('nope'), []);
  assert.equal(sanitizeTabs(Array.from({ length: 30 }, (_, i) => `#/c/${i}`)).length, MAX_TABS);
});

test('convMark: 承認の待ちは返事を作っている最中に起きるので、承認を優先する', () => {
  const draft = { conversationId: 'c1' };
  const approval = { conversationId: 'c1' };
  assert.equal(convMark([draft], [approval], 'c1'), 'approval', '下書きがあっても、承認の待ちが見える');
  assert.equal(convMark([draft], [], 'c1'), 'generating');
  assert.equal(convMark([], [approval], 'c1'), 'approval');
  assert.equal(convMark([draft], [approval], 'c2'), null, '別の会話には出ない');
  assert.equal(convMark([], [], 'c1'), null);
});

test('approvalTargetHash / isChatRun: 会話かタスクかは、一覧に載っているかではなく実行の種類で決める', () => {
  const context = (patch: Partial<RunContext> = {}): RunContext => ({ taskConversations: new Map([['task-conv', 't1']]), running: null, ...patch });
  assert.equal(approvalTargetHash({ conversationId: 'old-chat', runId: 'r1' }, context()), '#/c/old-chat', '一覧に載っていない古い会話でも会話へ');
  assert.equal(approvalTargetHash({ conversationId: 'task-conv', runId: 'r1' }, context()), '#/tasks/t1', 'タスクの実行の会話はタスクへ');
  assert.equal(approvalTargetHash({ conversationId: 'unknown', runId: 'r9' }, context({ running: { kind: 'task', taskId: 't2', runId: 'r9' } })), '#/tasks/t2', 'タスクの会話がまだ分からなくても、実行中の実行なら');
  assert.equal(approvalTargetHash({ conversationId: 'unknown', runId: 'r9' }, context({ running: { kind: 'review', taskId: null, runId: 'r9' } })), '#/c/unknown', '振り返りの実行はタスクへ送らない');
  assert.equal(isChatRun('r1', 'old-chat', context()), true, '一覧に載っていない会話の返事も会話の返事');
  assert.equal(isChatRun('r1', 'task-conv', context()), false, 'タスクの会話');
  assert.equal(isChatRun('r5', 'x', context({ running: { kind: 'review', taskId: null, runId: 'r5' } })), false, '実行中の振り返り・タスク');
});

test('conversationCountLabel: 一覧は 100 件までなので、100 件に届いたら「100+」と出す', () => {
  assert.equal(CONVERSATION_LIST_LIMIT, 100);
  assert.equal(conversationCountLabel(0), '0');
  assert.equal(conversationCountLabel(99), '99');
  assert.equal(conversationCountLabel(100), '100+');
});

test('loadTabs / saveTabs: ハッシュの一覧として保存し、読めない保存先や壊れた値でも落ちない', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  saveTabs([tab('#/c/a'), tab('#/tasks/t1')], storage);
  assert.equal(store.get('clive.tabs'), '["#/c/a","#/tasks/t1"]');
  assert.deepEqual(loadTabs(storage).map(x => x.hash), ['#/c/a', '#/tasks/t1']);
  store.set('clive.tabs', '{not json');
  assert.deepEqual(loadTabs(storage), []);
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.deepEqual(loadTabs(blocked), []);
  saveTabs([tab('#/')], blocked);
});

test('layoutModeFor: 760px 未満は狭い、1180px 未満は中くらい', () => {
  assert.equal(layoutModeFor(375), 'narrow');
  assert.equal(layoutModeFor(759), 'narrow');
  assert.equal(layoutModeFor(760), 'mid');
  assert.equal(layoutModeFor(1179), 'mid');
  assert.equal(layoutModeFor(1180), 'wide');
  assert.equal(layoutModeFor(1920), 'wide');
});

test('右のパネルの開き方は保存され、読めなくても閉じた状態になる', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  assert.equal(loadPanelPreference(storage), false);
  savePanelPreference(true, storage);
  assert.equal(loadPanelPreference(storage), true);
  savePanelPreference(false, storage);
  assert.equal(loadPanelPreference(storage), false);
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(loadPanelPreference(blocked), false);
  savePanelPreference(true, blocked);
});

test('Esc: 開いている重なりを、パレット → ダイアログ → 通知 → モデル → シート → 引き出しの順に 1 つずつ閉じる', () => {
  assert.deepEqual([...ESC_ORDER], ['palette', 'dialog', 'notification', 'model', 'sheet', 'drawer']);
  assert.equal(closeTopLayer(), false, '何も開いていなければ false（返事を止める側に回す）');
  const closed: string[] = [];
  const offs = [
    registerEscape('drawer', () => closed.push('drawer')),
    registerEscape('sheet', () => closed.push('sheet')),
    registerEscape('palette', () => closed.push('palette')),
  ];
  assert.equal(closeTopLayer(), true);
  assert.deepEqual(closed, ['palette']);
  offs[2]!();
  assert.equal(closeTopLayer(), true);
  assert.deepEqual(closed, ['palette', 'sheet']);
  offs[1]!();
  assert.equal(closeTopLayer(), true);
  assert.deepEqual(closed, ['palette', 'sheet', 'drawer']);
  offs[0]!();
  assert.equal(closeTopLayer(), false);
  const stale = registerEscape('drawer', () => closed.push('old'));
  const replacement = registerEscape('drawer', () => closed.push('new'));
  stale();
  assert.equal(closeTopLayer(), true, '古い登録を外しても、あとから登録したものは残る');
  assert.deepEqual(closed.slice(3), ['new']);
  replacement();
  assert.equal(closeTopLayer(), false);
});

test('shortcutOf: 日本語の変換中のキーは何にも使わない。⌘/Ctrl+/ は右のパネル、⌘/Ctrl+S は保存', () => {
  const key = (k: string, extra: object = {}) => ({ key: k, metaKey: false, ctrlKey: false, ...extra });
  assert.equal(shortcutOf(key('Escape')), 'escape');
  assert.equal(shortcutOf(key('Escape', { isComposing: true })), null, '変換を取り消す Esc では何もしない');
  assert.equal(shortcutOf(key('Escape', { keyCode: 229 })), null, 'keyCode 229 も変換中');
  assert.equal(shortcutOf(key('/', { ctrlKey: true })), 'togglePanel');
  assert.equal(shortcutOf(key('/', { metaKey: true })), 'togglePanel');
  assert.equal(shortcutOf(key('/')), null, '修飾キーなしの / は入力');
  assert.equal(shortcutOf(key('s', { ctrlKey: true })), 'save');
  assert.equal(shortcutOf(key('S', { metaKey: true })), 'save');
  assert.equal(shortcutOf(key('s')), null);
  assert.equal(shortcutOf(key('/', { ctrlKey: true, isComposing: true })), null);
  assert.equal(isComposing({ isComposing: true }), true);
  assert.equal(isComposing({ keyCode: 229 }), true);
  assert.equal(isComposing({ keyCode: 13 }), false);
  assert.equal(modLabel('MacIntel'), '⌘');
  assert.equal(modLabel('Win32'), 'Ctrl+');
});

test('formatRelativeCompact: サイドバー用の短い相対時刻', () => {
  reset();
  const now = Date.UTC(2026, 10, 5, 12, 0, 0);
  const ago = (ms: number) => formatRelativeCompact(now - ms, now);
  assert.equal(ago(10_000), '今');
  assert.equal(ago(5 * 60_000), '5分');
  assert.equal(ago(2 * 3_600_000), '2時間');
  assert.equal(ago(3 * 86_400_000), '3日');
  assert.equal(ago(45 * 86_400_000), '1か月');
  assert.equal(ago(400 * 86_400_000), '1年');
  assert.equal(ago(-5000), '今', '未来の時刻は今として扱う');
  setLanguagePreference('en');
  assert.equal(ago(10_000), 'now');
  assert.equal(ago(5 * 60_000), '5m');
  assert.equal(ago(2 * 3_600_000), '2h');
  assert.equal(ago(3 * 86_400_000), '3d');
  assert.equal(ago(45 * 86_400_000), '1mo');
  reset();
});

test('formatElapsed: 実行中の経過時間', () => {
  assert.equal(formatElapsed(0), '00:00');
  assert.equal(formatElapsed(59_999), '00:59');
  assert.equal(formatElapsed(61_000), '01:01');
  assert.equal(formatElapsed(3_600_000 + 4 * 60_000 + 7_000), '1:04:07');
  assert.equal(formatElapsed(-5000), '00:00');
});

test('presenceOf: 様子の一言は辞書から出て、言語に追従し、長いタスク名は切る', () => {
  reset();
  const base = { generating: false, runningTask: null, approvals: 0, waitingTasks: 0, paused: false, quiet: false, celebrating: false };
  assert.equal(presenceOf(base).line, 'ひと休みしています');
  assert.equal(presenceOf({ ...base, celebrating: true }).line, 'タスクを終えました');
  assert.equal(presenceOf({ ...base, generating: true }).line, '返事を考えています');
  assert.equal(presenceOf({ ...base, runningTask: '週報をまとめる' }).line, 'タスク「週報をまとめる」を進めています');
  assert.equal(presenceOf({ ...base, runningTask: '一二三四五六七八九十一二三四五六七八' }).line, 'タスク「一二三四五六七八九十一二三四…」を進めています');
  assert.equal(presenceOf({ ...base, runningTask: '一二三四五六七八九十一二三四' }).line, 'タスク「一二三四五六七八九十一二三四」を進めています', '14 文字までは切らない');
  assert.equal(presenceOf({ ...base, runningTask: '一二三四五六七八九十一二三四五' }).line, 'タスク「一二三四五六七八九十一二三四…」を進めています', '15 文字からは切る');
  assert.equal(presenceOf({ ...base, approvals: 2 }).line, '承認を待っています（2 件）');
  assert.equal(presenceOf({ ...base, waitingTasks: 3 }).line, '返事を待っています（3 件）');
  assert.equal(presenceOf({ ...base, paused: true }).line, 'お休み中（ワーカーを一時停止しています）');
  assert.equal(presenceOf({ ...base, quiet: true }).line, 'お休み中（静かにする時間帯です）');
  assert.equal(presenceOf({ ...base, paused: true }).sleeping, true);
  assert.equal(presenceOf({ ...base, approvals: 1 }).runtime, 'wait');
  setLanguagePreference('en');
  assert.equal(presenceOf(base).line, 'Taking a break');
  assert.equal(presenceOf({ ...base, runningTask: 'Weekly report' }).line, 'Working on task "Weekly report"');
  assert.equal(presenceOf({ ...base, approvals: 2 }).line, 'Waiting for approval (2)');
  reset();
});

test('辞書: 枠の文字は ja と en の両方にあり、en は ja の写しではない', () => {
  const framed = Object.keys(ja).filter(k => /^(nav|tab|panel|status|worker|theme|toast|presence)\./u.test(k));
  assert.ok(framed.length > 50, `枠の文字が ${framed.length} 件しか読めていない`);
  const same: string[] = [];
  for (const key of framed) {
    const jaEntry = (ja as Record<string, unknown>)[key];
    const enEntry = (en as Record<string, unknown>)[key];
    if (typeof jaEntry === 'string' && jaEntry === enEntry) same.push(key);
  }
  assert.deepEqual(same, [], '訳し忘れ（ja と同じ文字のまま）');
});

test('PAGE_META: 全ページに名前と絵があり、名前は辞書にある', () => {
  for (const page of ['chat', 'tasks', 'today', 'notifications', 'settings', 'runs', 'memory', 'review', 'skills', 'curiosity'] as const) {
    const meta = PAGE_META[page];
    assert.ok(meta.icon, `${page}: 絵が無い`);
    assert.ok(typeof (ja as Record<string, unknown>)[meta.label] === 'string', `${page}: ${meta.label} が辞書に無い`);
  }
});

test('workerState / pickChatModel: 状態バーに出す状態とモデル', () => {
  const worker = (patch: Partial<WorkerStatus>): WorkerStatus => ({ enabled: true, autonomy: true, paused: false, quiet: false, running: null, nextWakeAt: null, runsLastHour: 0, maxRunsPerHour: 6, ...patch });
  const running = { kind: 'task' as const, taskId: 't', runId: 'r', title: 'x' };
  assert.equal(workerState(null), 'disabled');
  assert.equal(workerState(worker({ enabled: false })), 'disabled');
  assert.equal(workerState(worker({ paused: true, running })), 'paused');
  assert.equal(workerState(worker({ running })), 'running');
  assert.equal(workerState(worker({ quiet: true })), 'quiet');
  assert.equal(workerState(worker({})), 'idle');
  const model = (id: string, name: string, status: string | null): ModelView => ({
    id, label: id, provider: 'p', model: name, contextLength: 1, minContext: 1, maxOutputTokens: 1, inChat: true,
    probe: status ? { modelId: id, status, server: 's', required: 1, message: '', checkedAt: 0 } : null,
  });
  const models = [model('a', 'model-a', 'error'), model('b', 'model-b', 'ok'), model('c', 'model-c', 'ok')];
  assert.equal(pickChatModel(models, { chat: ['a', 'b', 'c'] }), 'model-b', '使えるものの先頭');
  assert.equal(pickChatModel(models, { chat: ['a'] }), 'model-a', '使えるものが無ければ並びの先頭');
  assert.equal(pickChatModel(models, { chat: ['zzz', 'c'] }), 'model-c', '設定に無い ID は飛ばす');
  assert.equal(pickChatModel(models, { chat: [] }), null);
  assert.equal(pickChatModel([], { chat: ['a'] }), null);
});
