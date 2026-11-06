import assert from 'node:assert/strict';
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

test('自動承認と計画の説明は、できること・できないことを隠さない（Web の読み取りが外へ文字を出しうること、書き込み・送信・コードは自動承認でも確かめること）', () => {
  assert.match(ja['mode.planDesc'], /Web/u);
  assert.match(ja['mode.planDesc'], /URL/u);
  assert.match(ja['mode.autoDesc'], /書き込み/u);
  assert.match(ja['mode.autoDesc'], /コード/u);
  assert.match(en['mode.planDesc'], /URL/u);
  assert.match(en['mode.autoDesc'], /running code/u);
});
