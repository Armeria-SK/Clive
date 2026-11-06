import { mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { App } from './app.ts';
import { ConfigError } from './config/store.ts';
import { loadEnvFile, resolvePaths } from './paths.ts';
import { serverHostProblem } from './shared/url.ts';
import { createWebServer } from './web/server.ts';

const log = (line: string) => process.stdout.write(`${new Date().toISOString()} ${line}\n`);

// node src/main.ts [doctor] [--data-dir <dir>]（--data-dir は環境変数 CLIVE_DATA_DIR より優先）
const { values: args, positionals } = parseArgs({ options: { 'data-dir': { type: 'string' } }, allowPositionals: true });
const dataDir = args['data-dir'] ?? process.env.CLIVE_DATA_DIR;

async function start(): Promise<void> {
  loadEnvFile();
  const paths = resolvePaths(dataDir);
  mkdirSync(paths.data, { recursive: true });
  const app = new App({ paths, log });
  const config = app.config();
  // 待ち受けと認証は、起動したときの値（app.bootServer）で決める。起動の準備のあいだに設定ファイルが変わっても、反映は画面の「再起動する」から
  const boot = app.bootServer;
  const hostProblem = serverHostProblem(boot.host);
  if (hostProblem) throw new ConfigError(hostProblem);
  if (!config.models.length) log('[WARN] モデルがまだ設定されていません。画面の「はじめの設定」で足してください（足すまで、送信とワーカーは動きません）');
  else log('[INFO] モデルのコンテキスト長を確認しています…');
  const results = await app.status.probeAll(config);
  for (const r of results) log(`[${r.status === 'ok' ? 'INFO' : 'WARN'}] ${r.modelId}: ${r.status} — ${r.message}`);
  app.settleStaleNotifications();
  const web = createWebServer(app);
  await web.listen();
  log(`[INFO] Clive が起動しました: http://${boot.host}:${boot.port}/`);
  log('[INFO] ログインはありません。この URL を開ける人（この PC のほかのプログラムを含む）は誰でも Clive を操作できます');
  app.worker.start();
  log(`[INFO] ワーカー: ${config.worker.enabled ? `動いています（自発行動: ${config.worker.autonomy ? 'あり' : 'なし'}）` : '止めています（worker.enabled = false）'}`);
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    log('[INFO] 終了しています…');
    web.close();
    app.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function doctor(): Promise<number> {
  loadEnvFile();
  const paths = resolvePaths(dataDir);
  const app = new App({ paths, log: () => undefined });
  try {
    const config = app.config();
    process.stdout.write(`設定ファイル: ${paths.config}（OK）\n`);
    const results = await app.status.probeAll(config);
    let bad = 0;
    for (const r of results) {
      const used = config.routing.chat.includes(r.modelId) || config.routing.background.includes(r.modelId);
      const mark = r.status === 'ok' ? 'OK ' : used ? 'NG ' : '-- ';
      if (r.status !== 'ok' && used) bad++;
      process.stdout.write(`${mark} ${r.modelId}: ${r.message}${r.hint ? `\n     直し方: ${r.hint}` : ''}\n`);
    }
    if (!config.models.length) { process.stdout.write('NG  モデルがまだ設定されていません（画面の「はじめの設定」で足してください）\n'); bad++; }
    else if (!config.routing.chat.some(id => app.status.usable(id))) { process.stdout.write('NG  チャットで使えるモデルがありません\n'); bad++; }
    return bad ? 1 : 0;
  } finally { app.close(); }
}

const command = positionals[0];
try {
  if (command === 'doctor') process.exitCode = await doctor();
  else await start();
} catch (error) {
  if (error instanceof ConfigError) process.stderr.write(`設定エラー: ${error.message}\n`);
  else process.stderr.write(`起動できませんでした: ${(error as Error).stack ?? error}\n`);
  process.exitCode = 1;
}
