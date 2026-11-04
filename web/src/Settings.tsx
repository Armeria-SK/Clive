import { useEffect, useState } from 'react';
import { api, ApiError, type ModelView, type Profile, type SettingsView } from './api.ts';
import { ProfileEditor } from './Profile.tsx';

const STATUS_LABEL: Record<string, string> = {
  ok: '使えます', too_small: 'コンテキスト不足', exceeds_model: 'モデル上限超え', unknown: '長さ不明',
  unreachable: '接続できません', no_api_key: 'API キー未設定', not_found: 'モデルがありません', error: 'エラー',
};
const fmt = (n?: number) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');

export function Settings({ onProfile }: { onProfile: (p: Profile) => void }) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [models, setModels] = useState<ModelView[]>([]);
  const [draft, setDraft] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    const [s, m] = await Promise.all([api.settings(), api.models()]);
    setSettings(s); setModels(m.models); setDraft(JSON.stringify(s.config, null, 2));
  }
  useEffect(() => { void load(); }, []);

  async function probe() {
    setBusy(true);
    try { setModels((await api.probe()).models); } finally { setBusy(false); }
  }

  async function save() {
    setProblems([]); setSaved(false);
    let parsed: unknown;
    try { parsed = JSON.parse(draft); } catch { setProblems(['JSON として読めません（カンマや引用符を確認してください）']); return; }
    setBusy(true);
    try {
      const result = await api.saveSettings(parsed);
      setSettings(result); setModels(result.models); setDraft(JSON.stringify(result.config, null, 2)); setSaved(true);
    } catch (error) {
      if (error instanceof ApiError) setProblems(error.body?.problems?.length ? error.body.problems : [error.message]);
      else setProblems(['保存できませんでした']);
    } finally { setBusy(false); }
  }

  if (!settings) return <section className="page"><p className="muted">読み込み中…</p></section>;

  return (
    <section className="page">
      <h1>設定</h1>
      {settings.configError && (
        <div className="error-panel">
          <p>設定ファイルに問題があるため、直前の正しい設定で動いています。</p>
          <ul>{settings.configError.problems.map(p => <li key={p}>{p}</li>)}</ul>
        </div>
      )}
      {settings.restartRequired && <p className="notice warning">server の設定を変えました。反映するには Clive を再起動してください。</p>}

      <h2>名前と姿</h2>
      <ProfileEditor onSaved={p => { onProfile(p); void load(); }} />

      <h2>モデルとコンテキスト長</h2>
      <p className="muted">
        「必要」を下回るモデルは使いません（黙って切り捨てないため）。ローカル LLM のコンテキスト長の決め方は docs/config.md を見てください。
      </p>
      <div className="table-wrap">
        <table className="models">
          <thead><tr><th>モデル</th><th>状態</th><th>実際に使う長さ</th><th>必要</th><th>設定 / 実測 / モデル上限</th><th>内容</th></tr></thead>
          <tbody>
            {models.map(m => (
              <tr key={m.id}>
                <td><strong>{m.label}</strong>{m.inChat && <span className="tag">チャット</span>}<br /><code>{m.provider} / {m.model}</code></td>
                <td><span className={`badge ${m.probe?.status === 'ok' ? 'ok' : m.probe ? 'bad' : ''}`}>{m.probe ? STATUS_LABEL[m.probe.status] ?? m.probe.status : '未確認'}</span></td>
                <td>{fmt(m.probe?.effective)}</td>
                <td>{fmt(m.probe?.required)}</td>
                <td>{fmt(m.probe?.declared)} / {fmt(m.probe?.measured)} / {fmt(m.probe?.modelMax)}</td>
                <td>{m.probe?.message}{m.probe?.hint && <p className="hint">直し方: {m.probe.hint}</p>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button onClick={() => void probe()} disabled={busy}>確認し直す</button>

      <h2>API キー</h2>
      <p className="muted">キーの値は画面に出しません。.env か OS の環境変数に書いて、Clive を再起動してください。</p>
      <ul className="keys">
        {Object.entries(settings.apiKeys).map(([name, set]) => (
          <li key={name}><code>{name}</code> <span className={`badge ${set ? 'ok' : 'bad'}`}>{set ? '設定済み' : '未設定'}</span></li>
        ))}
      </ul>

      <h2>設定ファイル</h2>
      <p className="muted"><code>{settings.configPath}</code>。保存すると検証してから書き込み、前の版を .bak に残します。</p>
      <textarea className="config-editor" value={draft} onChange={e => { setDraft(e.target.value); setSaved(false); }} spellCheck={false} rows={28} aria-label="設定ファイル" />
      {problems.length > 0 && <div className="error-panel"><ul>{problems.map(p => <li key={p} className="pre">{p}</li>)}</ul></div>}
      {saved && <p className="notice ok">保存して、モデルを確認し直しました。</p>}
      <div className="row">
        <button onClick={() => void save()} disabled={busy}>保存</button>
        <button className="secondary" onClick={() => void load()} disabled={busy}>元に戻す</button>
      </div>
    </section>
  );
}
