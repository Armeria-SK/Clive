import { useState } from 'react';
import { api, ApiError, type Task, type WorkerStatus } from './api.ts';
import { formatDateTime } from './i18n/index.ts';

// タスクの画面は TasksPage.tsx に移した。ここに残っているのは、まだ Today.tsx が使う STATUS_LABEL と WorkerBar だけ（段階 6 で Today.tsx と一緒に消す）。
export const STATUS_LABEL: Record<Task['status'], string> = {
  inbox: '提案', ready: '実行待ち', running: '実行中', waiting: '返事待ち', scheduled: '繰り返し', done: '完了', failed: '失敗', cancelled: '取り消し',
};
const errorText = (error: unknown) => (error instanceof ApiError ? error.message : '送れませんでした');

export function WorkerBar({ worker, onChange }: { worker: WorkerStatus | null; onChange: (w: WorkerStatus) => void }) {
  const [error, setError] = useState('');
  if (!worker) return null;
  const set = (patch: { paused?: boolean; autonomy?: boolean }) => { setError(''); void api.setWorker(patch).then(onChange, e => setError(errorText(e))); };
  return (
    <div className="worker-bar">
      <span className={`dot ${worker.paused || !worker.enabled ? 'off' : 'on'}`} />
      <span>
        {!worker.enabled ? 'ワーカーは止めてあります（worker.enabled）'
          : worker.paused ? '一時停止中'
          : worker.running ? <>実行中: {worker.running.kind === 'task' && worker.running.taskId ? <a href={`#/tasks/${worker.running.taskId}`}>{worker.running.title}</a> : <a href="#/runs/reviews">{worker.running.title}</a>}</>
          : worker.quiet ? '静かにする時間帯' : '待機中'}
      </span>
      <span className="muted small">この1時間 {worker.runsLastHour}/{worker.maxRunsPerHour} 回{worker.nextWakeAt ? ` ・次に確かめる ${formatDateTime(worker.nextWakeAt)}` : ''}</span>
      <label className="toggle"><input type="checkbox" checked={worker.autonomy} onChange={e => set({ autonomy: e.target.checked })} /> 自発行動</label>
      <button className="secondary" onClick={() => set({ paused: !worker.paused })}>{worker.paused ? '再開' : '一時停止'}</button>
      {worker.running && <button className="stop" onClick={() => void api.stop(worker.running!.runId)}>止める</button>}
      {error && <span className="error-text">{error}</span>}
    </div>
  );
}
