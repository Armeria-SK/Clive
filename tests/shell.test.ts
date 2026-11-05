import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { ModelView, WorkerStatus } from '../web/src/api.ts';
import { presenceOf } from '../web/src/avatar.ts';
import { approvalTargetHash, CONVERSATION_LIST_LIMIT, conversationCountLabel, classifyRun, convMark, isChatGenerating, type RunContext } from '../web/src/conversation-state.ts';
import { en } from '../web/src/i18n/en.ts';
import { formatElapsed, formatRelativeCompact, setLanguagePreference, setTimezone } from '../web/src/i18n/index.ts';
import { ja } from '../web/src/i18n/ja.ts';
import { registerEscapeUnlessInert, saveKeyHandler } from '../web/src/inert.ts';
import { closeTopLayer, ESC_ORDER, isComposing, modLabel, registerEscape, shortcutOf } from '../web/src/keys.ts';
import { layoutModeFor, loadPanelPreference, savePanelPreference } from '../web/src/layout.ts';
import { notificationIcon, notificationKindLabel, notificationLink } from '../web/src/notification-meta.ts';
import { filterPalette, flattenPalette, moveIndex, type PaletteGroup, type PaletteGroupKey, type PaletteItem } from '../web/src/palette.ts';
import { PAGE_META, pickChatModel, workerState } from '../web/src/pages.ts';
import { chatHash, HOME_ROUTE, pageBehind, parseRoute, routeHash } from '../web/src/routes.ts';
import { closeTab, dropChats, findGoneChats, loadTabs, MAX_TABS, openTab, sanitizeTabs, saveTabs, toTab, unlistedChatIds, type ChatProbe, type Tab } from '../web/src/tabs.ts';

const reset = () => { setLanguagePreference('ja'); setTimezone('Asia/Tokyo'); };
const keys = (tabs: Tab[]) => tabs.map(x => x.key);
const tab = (hash: string): Tab => toTab(hash)!;

test('parseRoute: 古い経路（通知のリンクに保存されているもの）も、今の画面へ転送し続ける', () => {
  assert.deepEqual(parseRoute('#/today'), { page: 'today' });
  assert.deepEqual(parseRoute('#/notifications'), { page: 'notifications' });
  assert.deepEqual(parseRoute('#/review'), { page: 'review' });
  assert.deepEqual(parseRoute('#/memory'), { page: 'memory' });
  assert.deepEqual(parseRoute('#/curiosity'), { page: 'tasks', taskId: null, section: 'curiosity' }, '好奇心はタスクの「気になること」の節を開く');
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

test('toTab: タブになるのは会話だけ。タスク・スキル・実行ログ・記憶・通知・設定・きょうなどのページはタブにしない', () => {
  assert.deepEqual(toTab('#/c/a'), { key: 'chat:a', hash: '#/c/a' });
  assert.deepEqual(toTab('#/'), { key: 'chat:new', hash: '#/' });
  assert.deepEqual(toTab('#/xx'), { key: 'chat:new', hash: '#/' });
  for (const hash of ['#/tasks', '#/tasks/t9', '#/skills', '#/skills/draft/x', '#/runs', '#/runs/tools', '#/memory', '#/notifications', '#/settings', '#/today', '#/review', '#/curiosity']) {
    assert.equal(toTab(hash), null, hash);
  }
});


test('openTab: 会話から会話へは今のタブを置き換え、ページは何もしない。ページを見たあとに会話を開くと、直前に選んだ会話のタブを置き換える', () => {
  const start = [tab('#/c/a')];
  const second = openTab(start, '#/c/b', { activeKey: 'chat:a' });
  assert.deepEqual(keys(second), ['chat:b'], '会話のタブは置き換わる');
  const appended = openTab(start, '#/c/b', { activeKey: 'chat:a', append: true });
  assert.deepEqual(keys(appended), ['chat:a', 'chat:b'], '新しい会話は並べて足す');
  for (const page of ['#/tasks', '#/tasks/t1', '#/settings', '#/skills', '#/runs', '#/memory', '#/notifications', '#/today']) {
    assert.equal(openTab(appended, page, { activeKey: 'chat:b' }), appended, `${page} はタブを作らず、同じ配列を返す`);
  }
  const fromPage = openTab(appended, '#/c/z', { activeKey: 'chat:b' });
  assert.deepEqual(keys(fromPage), ['chat:a', 'chat:z'], 'ページを見たあとでも、直前に選んだ会話のタブ（b）が置き換わる');
  const closedBefore = openTab([tab('#/c/a')], '#/c/z', { activeKey: 'chat:b' });
  assert.deepEqual(keys(closedBefore), ['chat:a', 'chat:z'], '覚えていたタブがもう無ければ、置き換えずに足す');
  const same = openTab(appended, '#/c/a', { activeKey: 'chat:b' });
  assert.deepEqual(keys(same), ['chat:a', 'chat:b'], 'すでにあるタブはそのまま');
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

test('closeTab: 開いているタブを閉じたら隣へ移り、全部閉じたら新しい会話に戻る。会話以外のページを見ているときは、タブを閉じてもそのページに居続ける', () => {
  const tabs = [tab('#/c/a'), tab('#/c/b'), tab('#/c/c')];
  assert.equal(closeTab(tabs, 'chat:b', 'chat:b').go, '#/c/c', '右隣へ');
  assert.equal(closeTab(tabs, 'chat:c', 'chat:c').go, '#/c/b', '右が無ければ左隣へ');
  const other = closeTab(tabs, 'chat:b', 'chat:a');
  assert.equal(other.go, null, '今開いていないタブを閉じても移らない');
  assert.deepEqual(keys(other.tabs), ['chat:a', 'chat:c']);
  const onPage = closeTab(tabs, 'chat:b', null);
  assert.equal(onPage.go, null, 'タスクなどのページを見ているときは、どのタブを閉じても移らない');
  assert.deepEqual(keys(onPage.tabs), ['chat:a', 'chat:c']);
  const last = closeTab([tab('#/c/a')], 'chat:a', 'chat:a');
  assert.equal(last.go, '#/');
  assert.deepEqual(keys(last.tabs), ['chat:new']);
  const lastOnPage = closeTab([tab('#/c/a')], 'chat:a', null);
  assert.equal(lastOnPage.go, null, 'ページを見ているときに最後のタブを閉じても、そのページに居続ける');
  assert.deepEqual(keys(lastOnPage.tabs), ['chat:new'], '会話のタブが 0 になったら、新しい会話のタブを 1 つ置く');
  assert.equal(closeTab(tabs, 'nope', 'chat:a').tabs, tabs);
});


test('unlistedChatIds / dropChats: 一覧に無い会話のタブは確かめる対象にするだけで、消えた会話のタブだけを閉じる', () => {
  const tabs = [tab('#/c/a'), tab('#/c/old'), tab('#/c/gone'), tab('#/')];
  assert.deepEqual(unlistedChatIds(tabs, new Set(['a']), null), ['old', 'gone'], '新しい会話は対象にしない');
  assert.deepEqual(unlistedChatIds(tabs, new Set(['a']), 'chat:gone'), ['old'], '今開いているタブは対象にしない');
  assert.deepEqual(keys(dropChats(tabs, new Set(['gone']), null)), ['chat:a', 'chat:old', 'chat:new'], '404 だった会話だけ閉じる（一覧に無いだけの会話は残る）');
  assert.deepEqual(keys(dropChats(tabs, new Set(['gone']), 'chat:gone')), keys(tabs), '今開いているタブは閉じない');
  assert.equal(dropChats(tabs, new Set(), null), tabs);
});


test('findGoneChats: サーバーが無いと答えた（404）会話だけを返し、読めなかったときは消えたと見なさない', async () => {
  const verdicts: Record<string, ChatProbe> = { a: 'exists', b: 'gone', c: 'unknown' };
  const gone = await findGoneChats(['a', 'b', 'c', 'd'], async id => { if (id === 'd') throw new Error('network'); return verdicts[id]!; });
  assert.deepEqual([...gone], ['b']);
  assert.deepEqual([...(await findGoneChats([], async () => 'gone'))], []);
});

test('sanitizeTabs: 壊れた保存値を落とす。前の版が保存した、会話以外のページのタブも落とす', () => {
  assert.deepEqual(sanitizeTabs(['#/tasks', '#/tasks/x', '#/settings', 5, null, '#/today', '#/c/a', '#/c/a', '#/skills', '#/c/b']).map(x => x.hash), ['#/c/a', '#/c/b'], '重複・文字列でないもの・会話以外のページは捨てる');
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

test('approvalTargetHash / classifyRun: 会話かタスクかは、一覧に載っているかではなく実行の種類で決める', () => {
  const context = (patch: Partial<RunContext> = {}): RunContext => ({ taskConversations: new Map([['task-conv', 't1']]), running: null, ...patch });
  assert.equal(approvalTargetHash({ conversationId: 'old-chat', runId: 'r1' }, context()), '#/c/old-chat', '一覧に載っていない古い会話でも会話へ');
  assert.equal(approvalTargetHash({ conversationId: 'task-conv', runId: 'r1' }, context()), '#/tasks/t1', 'タスクの実行の会話はタスクへ');
  assert.equal(approvalTargetHash({ conversationId: 'unknown', runId: 'r9' }, context({ running: { kind: 'task', taskId: 't2', runId: 'r9' } })), '#/tasks/t2', 'タスクの会話がまだ分からなくても、実行中の実行なら');
  assert.equal(approvalTargetHash({ conversationId: 'unknown', runId: 'r9' }, context({ running: { kind: 'review', taskId: null, runId: 'r9' } })), '#/c/unknown', '振り返りの実行はタスクへ送らない');
  const listed = new Set(['listed-chat']);
  assert.equal(classifyRun('r1', 'listed-chat', context(), listed), 'chat', '一覧（chat だけが載る）に載っている会話');
  assert.equal(classifyRun('r1', 'old-chat', context(), listed), 'unknown', '一覧の外の会話は決めつけず、サーバーに会話の種類を尋ねる');
  assert.equal(classifyRun('r1', 'task-conv', context(), listed), 'background', 'タスクの会話');
  assert.equal(classifyRun('r5', 'x', context({ running: { kind: 'review', taskId: null, runId: 'r5' } }), listed), 'background', '実行中の振り返り・タスク');
  assert.equal(classifyRun('r6', 'review-conv', context(), listed), 'unknown', '短い振り返りで worker の状態がまだ届いていないときは、会話として扱わない');
});

test('conversationCountLabel: 一覧は 100 件までなので、100 件に届いたら「100+」と出す', () => {
  assert.equal(CONVERSATION_LIST_LIMIT, 100);
  assert.equal(conversationCountLabel(0), '0');
  assert.equal(conversationCountLabel(99), '99');
  assert.equal(conversationCountLabel(100), '100+');
});

test('loadTabs / saveTabs: ハッシュの一覧として保存し、読めない保存先や壊れた値でも落ちない。前の版が保存したページのタブは読み込みで落ちる', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
  saveTabs([tab('#/c/a'), tab('#/c/b')], storage);
  assert.equal(store.get('clive.tabs'), '["#/c/a","#/c/b"]');
  assert.deepEqual(loadTabs(storage).map(x => x.hash), ['#/c/a', '#/c/b']);
  store.set('clive.tabs', '["#/c/a","#/tasks/t1","#/settings"]');
  assert.deepEqual(loadTabs(storage).map(x => x.hash), ['#/c/a'], '古い保存値のタスク・設定のタブは落とす');
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

test('Esc: 開いている重なりを、パレット → ダイアログ → 通知 → 設定 → モデル → シート → 引き出しの順に 1 つずつ閉じる', () => {
  assert.deepEqual([...ESC_ORDER], ['palette', 'dialog', 'notification', 'settings', 'model', 'sheet', 'drawer']);
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
  assert.equal(presenceOf({ ...base, generating: true, approvals: 1 }).line, '返事を考えています', '返事を作っている最中が先（ただし承認待ちの会話は generating に数えない。下の isChatGenerating）');
  assert.equal(presenceOf({ ...base, runningTask: '週報', approvals: 1 }).line, '承認を待っています（1 件）', 'タスクの実行中でも、承認待ちが優先');
  assert.equal(presenceOf({ ...base, runningTask: '週報', approvals: 1 }).runtime, 'wait');
  setLanguagePreference('en');
  assert.equal(presenceOf(base).line, 'Taking a break');
  assert.equal(presenceOf({ ...base, runningTask: 'Weekly report' }).line, 'Working on task "Weekly report"');
  assert.equal(presenceOf({ ...base, approvals: 2 }).line, 'Waiting for approval (2)');
  reset();
});

test('辞書: 枠の文字は ja と en の両方にあり、en は ja の写しではない', () => {
  const framed = Object.keys(ja).filter(k => /^(nav|tab|panel|status|worker|theme|toast|presence|palette|notifications|task)\./u.test(k));
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
  for (const page of ['chat', 'tasks', 'today', 'notifications', 'settings', 'runs', 'memory', 'review', 'skills'] as const) {
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

const paletteItem = (id: string, label: string, sub = ''): PaletteItem => ({ id, label, sub, hint: '', icon: 'msg', run: () => undefined });
const paletteGroups = (): PaletteGroup[] => {
  const group = (key: PaletteGroupKey, items: PaletteItem[]): PaletteGroup => ({ key, label: key, items });
  return [
    group('actions', ['新しい会話', '設定を開く', '実行ログを開く', 'ダークにする', 'ワーカーを一時停止', 'スキル・ツールを開く'].map((label, i) => paletteItem(`a${i}`, label))),
    group('conversations', Array.from({ length: 7 }, (_, i) => paletteItem(`c${i}`, `会話 ${i}`))),
    group('tasks', [paletteItem('t0', '週報をまとめる'), paletteItem('t1', 'Backup the notes')]),
    group('skills', [paletteItem('s0', 'daily-report', '毎日の報告を作る手順'), paletteItem('s1', 'ｗｅｅｋｌｙ', '全角で書かれたスキル')]),
  ];
};

test('filterPalette: 空欄のときは操作はすべて、ほかの群は 4 件まで。語で絞ると全部から探し、空の群は出さない', () => {
  const empty = filterPalette(paletteGroups(), '   ');
  assert.deepEqual(empty.map(g => [g.key, g.items.length]), [['actions', 6], ['conversations', 4], ['tasks', 2], ['skills', 2]]);
  const conv = filterPalette(paletteGroups(), '会話');
  assert.deepEqual(conv.map(g => [g.key, g.items.length]), [['actions', 1], ['conversations', 7]], '絞ったときは 4 件で切らない。操作の「新しい会話」も当たる');
  assert.deepEqual(filterPalette(paletteGroups(), 'BACKUP').map(g => g.key), ['tasks'], '大文字小文字を区別しない');
  assert.deepEqual(filterPalette(paletteGroups(), '手順').flatMap(g => g.items.map(i => i.id)), ['s0'], '説明（sub）でも当たる');
  assert.deepEqual(filterPalette(paletteGroups(), 'weekly').flatMap(g => g.items.map(i => i.id)), ['s1'], '全角の英字を半角で探しても当たる');
  assert.deepEqual(filterPalette(paletteGroups(), 'ｄａｉｌｙ').flatMap(g => g.items.map(i => i.id)), ['s0'], '半角のものを全角で探しても当たる');
  assert.deepEqual(filterPalette(paletteGroups(), '当てはまらない語'), []);
  assert.deepEqual(flattenPalette(filterPalette(paletteGroups(), 'daily')).map(i => i.id), ['s0']);
});

test('moveIndex: ↑↓ は端で止まり、巻き戻らない', () => {
  assert.equal(moveIndex(0, 1, 3), 1);
  assert.equal(moveIndex(2, 1, 3), 2);
  assert.equal(moveIndex(0, -1, 3), 0);
  assert.equal(moveIndex(2, -1, 3), 1);
  assert.equal(moveIndex(5, 1, 0), 0);
});

test('shortcutOf: ⌘/Ctrl+K はコマンドパレット。日本語の変換中は使わない', () => {
  const key = (k: string, extra: object = {}) => ({ key: k, metaKey: false, ctrlKey: false, ...extra });
  assert.equal(shortcutOf(key('k', { ctrlKey: true })), 'palette');
  assert.equal(shortcutOf(key('K', { metaKey: true })), 'palette');
  assert.equal(shortcutOf(key('k')), null, '修飾キーなしの k は入力');
  assert.equal(shortcutOf(key('k', { ctrlKey: true, isComposing: true })), null);
});

test('notificationLink: 通知のリンクは、画面の経路として読めるものだけ開く（古い経路を含む）', () => {
  for (const link of ['#/tasks', '#/tasks/abc', '#/review', '#/settings', '#/c/xyz', '#/notifications', '#/curiosity', '#/today', '#/memory']) assert.equal(notificationLink(link), link, link);
  assert.equal(notificationLink('#/settings/models'), '#/settings/models', '正規の経路の下の続きは通す');
  for (const bad of [null, '', 'https://example.com/', 'javascript:alert(1)', '#', '#/nonsense', '#/c/', '//evil.example', '#//evil']) assert.equal(notificationLink(bad), null, String(bad));
});

test('notificationIcon / notificationKindLabel: サーバーの通知の種類ごとに絵と名前があり、知らない種類は「お知らせ」の絵になる', () => {
  for (const kind of ['task_done', 'task_waiting', 'task_failed', 'approval_needed', 'health_alert', 'info']) {
    assert.ok(notificationIcon(kind), `${kind}: 絵が無い`);
    const label = notificationKindLabel(kind);
    assert.ok(label && typeof (ja as Record<string, unknown>)[label] === 'string' && typeof (en as Record<string, unknown>)[label] === 'string', `${kind}: 名前が辞書に無い`);
  }
  assert.equal(notificationIcon('approval_needed'), 'shield');
  assert.equal(notificationIcon('task_failed'), 'circleX');
  assert.equal(notificationIcon('from-the-future'), 'info');
  assert.equal(notificationKindLabel('from-the-future'), null);
});

test('isChatGenerating: 承認待ちの会話は「返事を作っている」に数えず、タスクと振り返りの実行も数えない', () => {
  const drafts = [{ runId: 'r1', conversationId: 'c1' }];
  assert.equal(isChatGenerating(drafts, [], undefined), true);
  assert.equal(isChatGenerating(drafts, [{ conversationId: 'c1' }], undefined), false, '下書きが残っていても、承認待ちなら作っていない');
  assert.equal(isChatGenerating(drafts, [{ conversationId: 'other' }], undefined), true, '別の会話の承認待ちは関係ない');
  assert.equal(isChatGenerating(drafts, [], 'r1'), false, '実行中のタスク・振り返りの実行は数えない');
  assert.equal(isChatGenerating([...drafts, { runId: 'r2', conversationId: 'c2' }], [{ conversationId: 'c1' }], undefined), true, '承認待ちでない会話が 1 つでもあれば作っている');
  assert.equal(isChatGenerating([], [], undefined), false);
  const base = { generating: false, runningTask: null, approvals: 0, waitingTasks: 0, paused: false, quiet: false, celebrating: false };
  reset();
  const line = (generating: boolean) => presenceOf({ ...base, generating, approvals: 1 }).line;
  assert.equal(line(isChatGenerating(drafts, [{ conversationId: 'c1' }], undefined)), '承認を待っています（1 件）', '姿と一言も、承認待ちが勝つ');
});

const styleOf = (name: string): string => readFileSync(new URL(`../web/src/styles/${name}`, import.meta.url), 'utf8').replace(/\r/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const ruleOf = (css: string, selector: string): string => {
  const line = css.split('\n').find(l => l.startsWith(`${selector} {`));
  assert.ok(line, `${selector} の規則が見つからない`);
  return line;
};

test('幅の決まり: 会話の列・入力欄・ページ・タスク・実行ログの幅は tokens.css の --content-max と --content-gutter の 1 か所で決まる', () => {
  const tokens = styleOf('tokens.css');
  assert.match(tokens, /--content-max: \d+px;/, '最大の幅の変数');
  assert.match(tokens, /--content-gutter: clamp\(/, '左右の余白の変数');
  const targets: Array<[string, string]> = [
    ['chat.css', '.chat-col'], ['chat.css', '.chat-dock-inner'], ['shell.css', '.view-inner'], ['tasks.css', '.tk-inner'],
  ];
  for (const [file, selector] of targets) {
    const rule = ruleOf(styleOf(file), selector);
    assert.match(rule, /max-width: var\(--content-max\)/, `${selector} は最大の幅を変数で持つ`);
    assert.match(rule, /(padding-inline|padding): [^;]*var\(--content-gutter\)/, `${selector} は左右の余白を変数で持つ`);
    assert.doesNotMatch(rule, /max-width: \d+px/, `${selector} に数字の幅を書き戻さない`);
  }
  assert.doesNotMatch(styleOf('logs.css'), /lg-inner \{[^}]*max-width/, '実行ログだけ別の幅にしない（.view-inner と同じ）');
});

test('Esc: 設定のモーダルは、確かめのダイアログの下で、後ろのページのシートや引き出しの上。ダイアログ → 設定 → シートの順に 1 つずつ閉じる', () => {
  const closed: string[] = [];
  const offs = [
    registerEscape('sheet', () => closed.push('sheet')),
    registerEscape('settings', () => closed.push('settings')),
    registerEscape('dialog', () => closed.push('dialog')),
  ];
  assert.equal(closeTopLayer(), true);
  assert.deepEqual(closed, ['dialog']);
  offs[2]!();
  assert.equal(closeTopLayer(), true);
  assert.deepEqual(closed, ['dialog', 'settings']);
  offs[1]!();
  assert.equal(closeTopLayer(), true);
  assert.deepEqual(closed, ['dialog', 'settings', 'sheet']);
  offs[0]!();
  assert.equal(closeTopLayer(), false);
  assert.deepEqual(closed, ['dialog', 'settings', 'sheet']);
});

test('pageBehind: 設定はモーダルなので、後ろには直前に見ていたページを描く。直前が無ければ新しい会話', () => {
  const tasks = parseRoute('#/tasks/t1');
  assert.deepEqual(pageBehind(parseRoute('#/settings'), tasks), tasks, '設定の後ろは直前のページ（タスクの詳細まで）');
  assert.deepEqual(pageBehind(parseRoute('#/settings'), parseRoute('#/c/a')), { page: 'chat', conversationId: 'a' });
  assert.deepEqual(pageBehind(parseRoute('#/settings'), null), HOME_ROUTE, '設定を直接開いたときは新しい会話');
  assert.deepEqual(HOME_ROUTE, { page: 'chat', conversationId: null });
  assert.deepEqual(pageBehind(parseRoute('#/skills'), tasks), parseRoute('#/skills'), '設定でなければ、そのページ自身');
  assert.deepEqual(parseRoute('#/settings/models'), { page: 'settings' }, '#/settings は今までどおり読める（通知のリンクも同じ）');
});

test('inert: 設定のモーダルが開いている間、後ろのページの Esc の重なりと ⌘/Ctrl+S は受け付けない', () => {
  const closed: string[] = [];
  assert.equal(registerEscapeUnlessInert('dialog', () => closed.push('background-dialog'), true), undefined, '後ろのページの確かめは登録されない');
  const off = registerEscapeUnlessInert('settings', () => closed.push('settings'), false)!;
  assert.equal(closeTopLayer(), true);
  assert.deepEqual(closed, ['settings'], 'Esc は設定だけに届く（後ろの確かめがダイアログの順番で先に閉じない）');
  off();
  assert.equal(closeTopLayer(), false);

  let saved = 0;
  let prevented = 0;
  const press = (key: string, ctrl = true) => ({ key, metaKey: false, ctrlKey: ctrl, preventDefault: () => { prevented += 1; } });
  saveKeyHandler(() => true, () => { saved += 1; })(press('s'));
  assert.deepEqual({ saved, prevented }, { saved: 0, prevented: 0 }, '後ろのページの ⌘/Ctrl+S は何もしない');
  const live = saveKeyHandler(() => false, () => { saved += 1; });
  live(press('s'));
  assert.deepEqual({ saved, prevented }, { saved: 1, prevented: 1 }, '開いている側の ⌘/Ctrl+S は保存し、ブラウザの「ページを保存」を止める');
  live(press('s', false));
  live(press('k'));
  assert.deepEqual({ saved, prevented }, { saved: 1, prevented: 1 }, '別のキーは何もしない');
});
