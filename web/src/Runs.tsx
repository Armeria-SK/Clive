import { useEffect, useState } from 'react';
import { api, type RunRow } from './api.ts';
import { formatDateTime, formatNumber } from './i18n/index.ts';
import { ZoneNote } from './ZoneNote.tsx';

const time = (ms: number) => formatDateTime(ms, 'precise');
const n = (v: number | null) => (v === null ? '—' : formatNumber(v));

export function Runs() {
  const [runs, setRuns] = useState<RunRow[]>([]);
  useEffect(() => { void api.runs().then(r => setRuns(r.runs)); }, []);
  return (
    <section className="page">
      <h1>実行ログ</h1>
      <p><ZoneNote /></p>
      <button className="secondary" onClick={() => void api.runs().then(r => setRuns(r.runs))}>更新</button>
      <div className="table-wrap">
        <table>
          <thead><tr><th>時刻</th><th>種類</th><th>モデル</th><th>結果</th><th>試行</th><th>秒</th><th>入力 / 出力 / キャッシュ</th><th>見積もり</th><th>内容</th></tr></thead>
          <tbody>
            {runs.map(r => (
              <tr key={r.id}>
                <td>{time(r.started_at)}</td>
                <td>{r.kind}</td>
                <td>{r.model_id ?? '—'}</td>
                <td><span className={`badge ${r.ok === 1 ? 'ok' : r.ok === 0 ? 'bad' : ''}`}>{r.ok === 1 ? '成功' : r.ok === 0 ? (r.error_kind ?? '失敗') : '実行中'}</span></td>
                <td>{r.attempts}</td>
                <td>{r.duration_ms === null ? '—' : (r.duration_ms / 1000).toFixed(1)}</td>
                <td>{n(r.input_tokens)} / {n(r.output_tokens)} / {n(r.cache_read_tokens)}</td>
                <td>{n(r.est_prompt_tokens)}</td>
                <td>{r.error_message}{r.flags.length > 0 && <span className="tag">{r.flags.join(', ')}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
