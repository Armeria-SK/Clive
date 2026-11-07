import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { PERMISSION_MODES } from '../src/shared/permission-mode.ts';
import { en } from '../web/src/i18n/en.ts';
import { setLanguagePreference, t } from '../web/src/i18n/index.ts';
import { ja } from '../web/src/i18n/ja.ts';

// 段 8b の画面: 入力欄の権限モードの札・一覧・「この計画で進める」の文

const CJK = /[　-ヿ㐀-䶿一-鿿＀-￯]/u;

test('権限モードの画面の文: 3 つのモードそれぞれの名前と説明が日本語・英語にあり、英語に日本語が混ざらない', () => {
  for (const mode of PERMISSION_MODES) {
    for (const key of [`mode.${mode}`, `mode.${mode}Desc`] as const) {
      assert.ok(key in ja && key in en, key);
      assert.doesNotMatch(en[key] as string, CJK, key);
      assert.match(ja[key] as string, CJK, key);
    }
  }
  for (const key of ['mode.chip', 'mode.menu', 'mode.switched', 'mode.failed', 'mode.autoChecking', 'plan.proceed', 'plan.proceedHint', 'plan.proceedRequest', 'runs.autoReason'] as const) {
    assert.doesNotMatch(en[key] as string, CJK, key);
  }
  setLanguagePreference('en');
  assert.doesNotMatch(t('mode.statusTip', t('mode.auto')), CJK);
  assert.doesNotMatch(t('notice.autoAllowed', 'shell_run', 'reads the memo'), CJK);
  setLanguagePreference('ja');
  assert.match(t('mode.statusTip', t('mode.plan')), /計画/u);
});

test('「この計画で進める」: 送る依頼の文は言語別。ボタンの名前と別の文', () => {
  setLanguagePreference('ja');
  assert.equal(t('plan.proceedRequest'), 'この計画どおりに進めてください。');
  assert.equal(t('plan.proceed'), 'この計画で進める');
  setLanguagePreference('en');
  assert.equal(t('plan.proceedRequest'), 'Please go ahead with this plan.');
  assert.doesNotMatch(t('plan.proceedRequest'), CJK);
  setLanguagePreference('ja');
});

test('自動承認と計画の説明は、できること・できないことを隠さない（Web の読み取りが外へ文字を出しうること、コードを動かす確かめ・外への書き込みは自動承認でも人に聞くこと）', () => {
  assert.match(ja['mode.planDesc'], /Web/u);
  assert.match(ja['mode.planDesc'], /URL/u);
  assert.match(ja['mode.autoDesc'], /書き込み/u);
  assert.match(ja['mode.autoDesc'], /コード/u);
  assert.match(en['mode.planDesc'], /URL/u);
  assert.match(en['mode.autoDesc'], /Running code/u);
});

test('自動承認の説明（画面と README）は、いま効く範囲を書く: よそから来た文を読んだあとも判断のモデルが決めること、送る・消す・分からない操作は何と答えても必ず聞くこと、「この会話では許可」は効くこと、許可フォルダの外は止めたままであること', () => {
  assert.match(ja['mode.autoDesc'], /よそから来た文を読んだあと/u);
  assert.match(ja['mode.autoDesc'], /Web/u);
  assert.match(ja['mode.autoDesc'], /添付/u);
  assert.match(ja['mode.autoDesc'], /外へ送る操作/u);
  assert.match(ja['mode.autoDesc'], /消す操作/u);
  assert.match(ja['mode.autoDesc'], /何と答えても、いつもあなたに聞きます/u);
  assert.match(ja['mode.autoDesc'], /この会話では許可/u);
  assert.match(ja['mode.autoDesc'], /止める/u);
  assert.match(ja['mode.autoDesc'], /秘密のファイル/u);
  assert.match(en['mode.autoDesc'], /text that came from elsewhere/u);
  assert.match(en['mode.autoDesc'], /web pages/iu);
  assert.match(en['mode.autoDesc'], /attachments/iu);
  assert.match(en['mode.autoDesc'], /sends something out/u);
  assert.match(en['mode.autoDesc'], /deletes/u);
  assert.match(en['mode.autoDesc'], /whatever the model answers/u);
  assert.match(en['mode.autoDesc'], /Allow in this chat/u);
  assert.match(en['mode.autoDesc'], /Block/u);
  assert.match(en['mode.autoDesc'], /Secret files/u);
  for (const [name, value] of [['ja', ja['mode.autoDesc']], ['en', en['mode.autoDesc']]] as const) {
    assert.doesNotMatch(value, /外を読んだ|外から読んだ|外の内容|outside content/iu, `${name}: 分かりにくい言い回しを画面に出さない`);
    assert.doesNotMatch(value, /毎回あなたに聞きます|asked of you every time/u, `${name}: 「読んだことのある会話は毎回聞く」という古い決まりを書かない`);
  }
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const line = readme.split(/\r?\n/u).find(l => l.startsWith('- **自動承認**'));
  assert.ok(line, 'README に自動承認の説明がある');
  assert.doesNotMatch(line, /サービスの操作|リモートの設定|開くと理由/u);
  assert.match(line, /tools\.outsideRoots/u);
  assert.match(line, /よそから来た文を読んだあとの確かめ/u);
  assert.match(line, /何と答えても必ずあなたに聞く/u);
  assert.match(line, /この会話では許可/u);
  assert.doesNotMatch(line, /一度でも Web・添付|判断のモデルを使わず、毎回あなたに確かめる/u, 'よそから来た文を読んだ会話は判断のモデルを使わない、という古い決まりを書かない');
  assert.match(line, /自動承認の残る危険/u);
  assert.match(line, /`web_fetch` `web_search`/u, '残る危険: Web の読み取りは読んだあとも確かめなしで動き、URL で少し外へ出せる');
  assert.match(line, /`package\.json`/u, '残る危険: 判断のモデルがだまされると、あとで動くファイルも書き換えられる');
});

test('README と画面の文に、分かりにくい言い回し「外から読んだ」「外を読んだ扱い」「外から来た」「外の内容を読んだ」が残っていない（「よそから来た文を読んだ」と言う）', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.doesNotMatch(readme, /外から読んだ|外を読んだ扱い|外から来た|外の内容を読んだ/u);
  for (const [name, table] of [['ja', ja], ['en', en]] as const) {
    for (const [key, value] of Object.entries(table)) {
      if (typeof value !== 'string') continue;
      assert.doesNotMatch(value, /外から読んだ|外を読んだ扱い|外から来た|外の内容を読んだ|outside content/iu, `${name} ${key}`);
    }
  }
});
