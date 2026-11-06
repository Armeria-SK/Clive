import type { App } from '../app.ts';
import { ConfigError } from '../config/store.ts';
import { estimateTextTokens } from '../engine/tokens.ts';
import {
  isInitialPersona, normalizePersonaInput, startsWithHash, PERSONA_MAX_CHARS, PersonaError, personaTexts, readPersona, STYLE_NOTE_MAX_CHARS, STYLES, USER_NAME_MAX_CHARS, NAME_MAX_CHARS,
  writePersonaFile, type PersonaInput, type Style,
} from '../engine/persona.ts';
import { reloadEnvFile } from '../paths.ts';
import { languageOf } from '../shared/language.ts';
import { configProblem, problem, readJson, requireObject, requireString, type Router, sendJson } from './http.ts';

const DONE_KEY = 'onboarding:done';
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
const STEPS_KEY = 'onboarding:steps';

type StepFlags = { user?: boolean; identity?: boolean; persona?: boolean };

function personaProblem(error: unknown): never {
  if (error instanceof PersonaError) throw problem(409, 'persona_unsafe', 'persona_unsafe', { params: { file: error.file } });
  throw error;
}

export function registerOnboardingRoutes(router: Router, app: App): void {
  const state = () => {
    const config = app.config();
    const flags = app.kv.getJson<StepFlags>(STEPS_KEY) ?? {};
    const started = Object.values(flags).some(Boolean);
    const { soul, user } = readPersona(app.paths);
    const usedAlready = (app.db.prepare('SELECT COUNT(*) AS n FROM conversations').get() as { n: number }).n > 0
      || (app.db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n > 0
      || !isInitialPersona(app.paths, 'SOUL.md', soul) || !isInitialPersona(app.paths, 'USER.md', user);
    // 画面からはじめの設定を始めたあとは「使っている」とは見なさない（途中で閉じても、続きの案内を残す）。すでに使っているデータには出さない。
    const done = app.kv.get(DONE_KEY) !== undefined || (!started && usedAlready);
    return {
      done,
      steps: { language: config.language !== undefined, user: Boolean(flags.user), identity: Boolean(flags.identity), persona: Boolean(flags.persona), model: config.models.length > 0 },
    };
  };

  router.add('GET', '/api/onboarding', ({ res }) => sendJson(res, 200, state()));
  router.add('POST', '/api/onboarding/done', ({ res }) => {
    app.kv.set(DONE_KEY, String(Date.now()));
    sendJson(res, 200, state());
  });

  // 名前・呼び方・話し方の書き込みはサーバーだけが行う（画面は値を送るだけ）。書くのは作業フォルダの SOUL.md と USER.md の決まった節だけ。
  router.add('POST', '/api/onboarding/persona', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    const raw: PersonaInput = {};
    const userName = requireString(body, 'userName', { optional: true, max: USER_NAME_MAX_CHARS });
    const callMe = requireString(body, 'callMe', { optional: true, max: USER_NAME_MAX_CHARS });
    const botName = requireString(body, 'botName', { optional: true, max: NAME_MAX_CHARS });
    const styleNote = requireString(body, 'styleNote', { optional: true, max: STYLE_NOTE_MAX_CHARS });
    if (userName !== undefined) raw.userName = userName;
    if (callMe !== undefined) raw.callMe = callMe;
    if (botName !== undefined) raw.botName = botName;
    if (styleNote !== undefined) raw.styleNote = styleNote;
    if (body.style !== undefined) {
      if (typeof body.style !== 'string' || !(STYLES as readonly string[]).includes(body.style)) throw problem(400, 'invalid_field', 'bad_enum', { field: 'style', params: { field: 'style', values: STYLES.join(' / ') } });
      raw.style = body.style as Style;
    }
    for (const field of ['userName', 'callMe', 'botName'] as const) {
      const value = raw[field];
      if (value !== undefined && startsWithHash(value)) throw problem(400, 'invalid_field', 'bad_hash_start', { field, params: { field } });
    }
    const input = normalizePersonaInput(raw);
    if (!Object.keys(input).length) throw problem(400, 'invalid_field', 'persona_empty');
    if (input.botName !== undefined && !input.botName) throw problem(400, 'invalid_field', 'empty_name', { field: 'botName' });
    const config = app.config();
    const language = languageOf(config);
    try {
      const current = readPersona(app.paths);
      const next = personaTexts(current.soul, current.user, language, input);
      if (next.soul !== current.soul) writePersonaFile(app.paths, 'SOUL.md', next.soul);
      if (next.user !== current.user) writePersonaFile(app.paths, 'USER.md', next.user);
    } catch (error) { personaProblem(error); }
    // 画面に出す名前（profile）と SOUL.md の名前は、いつも一緒に書く
    if (input.botName !== undefined && config.profile.name !== input.botName) {
      try { await app.applyConfig({ ...config, profile: { ...config.profile, name: input.botName } }); }
      catch (error) {
        if (error instanceof ConfigError) throw configProblem(error);
        throw error;
      }
    }
    const flags: StepFlags = { ...(app.kv.getJson<StepFlags>(STEPS_KEY) ?? {}) };
    if (input.userName !== undefined || input.callMe !== undefined) flags.user = true;
    if (input.botName !== undefined) flags.identity = true;
    if (input.style !== undefined || input.styleNote !== undefined) flags.persona = true;
    app.kv.setJson(STEPS_KEY, flags);
    sendJson(res, 200, { profile: app.config().profile, ...state() });
  });

  // SOUL.md と USER.md の全文（設定の「Clive について」の編集）。利用者自身の編集なので承認は要らない。
  const personaView = () => {
    const { soul, user } = readPersona(app.paths);
    return { soul, user, tokens: { soul: estimateTextTokens(soul), user: estimateTextTokens(user) }, budget: app.engine.personaBudget() ?? null, max: PERSONA_MAX_CHARS };
  };
  router.add('GET', '/api/workspace/persona', ({ res }) => sendJson(res, 200, personaView()));
  router.add('PUT', '/api/workspace/persona', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    const soul = requireString(body, 'soul', { optional: true, max: PERSONA_MAX_CHARS });
    const user = requireString(body, 'user', { optional: true, max: PERSONA_MAX_CHARS });
    if (soul === undefined && user === undefined) throw problem(400, 'invalid_field', 'required', { field: 'soul', params: { field: 'soul' } });
    try {
      if (soul !== undefined) writePersonaFile(app.paths, 'SOUL.md', soul);
      if (user !== undefined) writePersonaFile(app.paths, 'USER.md', user);
    } catch (error) { personaProblem(error); }
    sendJson(res, 200, personaView());
  });

  // 起動したあとに .env へ書いた鍵を読み込む。読むのは決まった .env だけ（パスは受け取らない）。返すのは鍵があるかどうかと、起動し直さないと変わらない変数の名前だけ（値は返さない）。
  // 画面が、これから足そうとしている鍵の環境変数の名前（env）を 1 つだけ尋ねられる（設定のプロバイダの鍵のほかに、尋ねてよいのはそれだけ）。名前の形（大文字・数字・_）に合わないものは無視し、返すのは有無だけ。
  router.add('POST', '/api/onboarding/reload-env', async ({ req, res }) => {
    const body = requireObject(await readJson(req));
    const asked = Array.isArray(body.env) ? body.env.find((k): k is string => typeof k === 'string' && ENV_NAME.test(k)) : undefined;
    const { loaded, notApplied } = reloadEnvFile(app.paths.env);
    const config = app.config();
    const names = [...new Set([...config.providers.map(p => p.apiKeyEnv ?? (p.kind === 'anthropic' ? 'ANTHROPIC_API_KEY' : undefined)).filter((k): k is string => Boolean(k)), ...(asked ? [asked] : [])])];
    sendJson(res, 200, { loaded, apiKeys: Object.fromEntries(names.map(k => [k, Boolean(process.env[k]?.trim())])), notApplied: notApplied.filter(k => names.includes(k)) });
  });
}
