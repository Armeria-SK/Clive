import { Type, type Static } from '@sinclair/typebox';

export const ProviderKind = Type.Union([
  Type.Literal('anthropic'),
  Type.Literal('openai_compatible'),
  Type.Literal('ollama'),
]);

export const ServerKind = Type.Union([
  Type.Literal('lmstudio'),
  Type.Literal('llamacpp'),
  Type.Literal('vllm'),
  Type.Literal('tabbyapi'),
  Type.Literal('openrouter'),
  Type.Literal('openai'),
  Type.Literal('generic'),
]);

export const ProviderConfig = Type.Object({
  id: Type.String({ pattern: '^[a-z0-9][a-z0-9_-]{0,39}$' }),
  kind: ProviderKind,
  baseUrl: Type.Optional(Type.String({ maxLength: 2048 })),
  apiKeyEnv: Type.Optional(Type.String({ pattern: '^[A-Z][A-Z0-9_]{0,63}$' })),
  server: Type.Optional(ServerKind),
  maxParallel: Type.Integer({ minimum: 1, maximum: 8, default: 1 }),
  timeoutMs: Type.Integer({ minimum: 1000, maximum: 3_600_000, default: 600_000 }),
}, { additionalProperties: false });

export const ModelConfig = Type.Object({
  id: Type.String({ pattern: '^[a-z0-9][a-z0-9_.-]{0,63}$' }),
  label: Type.Optional(Type.String({ maxLength: 80 })),
  provider: Type.String(),
  model: Type.String({ minLength: 1, maxLength: 200 }),
  contextLength: Type.Optional(Type.Integer({ minimum: 1024, maximum: 10_000_000 })),
  minContext: Type.Integer({ minimum: 1024, maximum: 10_000_000, default: 65536 }),
  maxOutputTokens: Type.Integer({ minimum: 256, maximum: 200_000, default: 8192 }),
  toolMode: Type.Union([Type.Literal('native'), Type.Literal('json_fallback')], { default: 'native' }),
  maxTools: Type.Optional(Type.Integer({ minimum: 0, maximum: 128 })),
  vision: Type.Boolean({ default: false }),
  temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
}, { additionalProperties: false });

export const ServerConfig = Type.Object({
  host: Type.String({ default: '127.0.0.1' }),
  port: Type.Integer({ minimum: 1, maximum: 65535, default: 4777 }),
  origins: Type.Array(Type.String({ maxLength: 300 }), { default: [] }),
  tailscaleLogins: Type.Array(Type.String({ maxLength: 256 }), { default: [] }),
}, { additionalProperties: false });

export const RoutingConfig = Type.Object({
  chat: Type.Array(Type.String(), { default: [] }),
  background: Type.Array(Type.String(), { default: [] }),
  retriesPerModel: Type.Integer({ minimum: 0, maximum: 5, default: 2 }),
}, { additionalProperties: false });

export const AVATAR_SHAPES = [
  'pebble', 'triangle', 'diamond', 'bean', 'cloud', 'droplet', 'heart', 'star', 'crescent', 'capsule',
  'square', 'puddle', 'ghost', 'bunny', 'cat', 'bear', 'mushroom', 'bell', 'peanut', 'comet',
] as const;

export const RESTART_KEYS = ['server'] as const;

export const LANGUAGES = ['ja', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = 'ja';

export const RootConfig = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 1024 }),
  mode: Type.Union([Type.Literal('read'), Type.Literal('write')]),
}, { additionalProperties: false });

export const HookConfig = Type.Object({
  matcher: Type.String({ minLength: 1, maxLength: 200 }),
  command: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  timeoutMs: Type.Integer({ minimum: 100, maximum: 120_000, default: 30_000 }),
  onError: Type.Union([Type.Literal('deny'), Type.Literal('ask')], { default: 'deny' }),
}, { additionalProperties: false });

export function ToolsConfig() {
  return Type.Object({
    roots: Type.Array(RootConfig, { default: [{ path: 'workspace', mode: 'write' }] }),
    deny: Type.Array(Type.String({ minLength: 1 }), { default: ['~/.ssh', '~/.aws', '~/.gnupg'] }),
    outsideRoots: Type.Union([Type.Literal('ask'), Type.Literal('deny')], { default: 'ask' }),
    taintEscalation: Type.Boolean({ default: true }),
    shell: Type.Object({
      enabled: Type.Boolean({ default: true }),
      shell: Type.Union([Type.Literal('auto'), Type.Literal('pwsh'), Type.Literal('powershell'), Type.Literal('bash'), Type.Literal('sh')], { default: 'auto' }),
      timeoutSec: Type.Integer({ minimum: 1, maximum: 3600, default: 120 }),
      maxTimeoutSec: Type.Integer({ minimum: 1, maximum: 3600, default: 600 }),
      outputCapBytes: Type.Integer({ minimum: 1024, maximum: 4 * 1024 * 1024, default: 65536 }),
      allow: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
      ask: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
      deny: Type.Array(Type.String({ minLength: 1 }), { default: [] }),
      envAllow: Type.Array(Type.String(), { default: [] }),
      approvalTimeoutSec: Type.Integer({ minimum: 10, maximum: 3600, default: 600 }),
    }, { additionalProperties: false, default: {} }),
    hooks: Type.Object({
      preToolUse: Type.Array(HookConfig, { default: [] }),
      postToolUse: Type.Array(HookConfig, { default: [] }),
    }, { additionalProperties: false, default: {} }),
    web: Type.Object({
      fetch: Type.Boolean({ default: true }),
      search: Type.Union([Type.Literal('duckduckgo'), Type.Literal('searxng'), Type.Literal('off')], { default: 'duckduckgo' }),
      searxngUrl: Type.String({ default: '' }),
      region: Type.String({ default: 'jp-jp', maxLength: 10 }),
      maxSearchesPerHour: Type.Integer({ minimum: 1, maximum: 600, default: 30 }),
    }, { additionalProperties: false, default: {} }),
    // 1 回の実行で道具を呼べる回数。0 は制限なし（止めるのは、止めるボタン・取り消し・割り込み・承認の拒否や時間切れ・コンテキストの量だけ）
    maxIterations: Type.Integer({ minimum: 0, maximum: 100, default: 16 }),
  }, { additionalProperties: false, default: {} });
}

export const AppConfig = Type.Object({
  $schema: Type.Optional(Type.String()),
  version: Type.Literal(1),
  timezone: Type.String({ default: 'Asia/Tokyo' }),
  language: Type.Optional(Type.Union(LANGUAGES.map(l => Type.Literal(l)))),
  server: ServerConfig,
  providers: Type.Array(ProviderConfig, { default: [] }),
  models: Type.Array(ModelConfig, { default: [] }),
  routing: RoutingConfig,
  tools: ToolsConfig(),
  profile: Type.Object({
    name: Type.String({ minLength: 1, maxLength: 40, default: 'Clive' }),
    shape: Type.Union(AVATAR_SHAPES.map(s => Type.Literal(s)), { default: 'pebble' }),
    color: Type.String({ pattern: '^#[0-9a-fA-F]{6}$', default: '#61B8A5' }),
    motion: Type.Union([Type.Literal('auto'), Type.Literal('none'), Type.Literal('float'), Type.Literal('sway'), Type.Literal('pulse')], { default: 'auto' }),
  }, { additionalProperties: false, default: {} }),
  worker: Type.Object({
    enabled: Type.Boolean({ default: true }),
    autonomy: Type.Boolean({ default: false }),
    maxRunsPerHour: Type.Integer({ minimum: 1, maximum: 120, default: 6 }),
    idleMinutes: Type.Integer({ minimum: 0, maximum: 1440, default: 5 }),
    quietStart: Type.String({ default: '', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$|^$' }),
    quietEnd: Type.String({ default: '', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$|^$' }),
    selfTasksNeedApproval: Type.Boolean({ default: false }),
    remindAfterHours: Type.Integer({ minimum: 1, maximum: 720, default: 12 }),
    curiosityPerDay: Type.Integer({ minimum: 0, maximum: 48, default: 2 }),
  }, { additionalProperties: false, default: {} }),
  memory: Type.Object({
    userMaxChars: Type.Optional(Type.Integer()),
    notesMaxChars: Type.Optional(Type.Integer()),
    review: Type.Boolean({ default: true }),
    reviewIdleMinutes: Type.Integer({ minimum: 5, maximum: 1440, default: 30 }),
    reviewAfterToolCalls: Type.Integer({ minimum: 1, maximum: 200, default: 8 }),
  }, { additionalProperties: false, default: {} }),
}, { additionalProperties: false });

export type ProviderConfig = Static<typeof ProviderConfig>;
export type ModelConfig = Static<typeof ModelConfig>;
export type AppConfig = Static<typeof AppConfig>;
export type ToolsConfig = Static<ReturnType<typeof ToolsConfig>>;
export type HookConfig = Static<typeof HookConfig>;
