import { useEffect, useState } from 'react';
import { api, ApiError, type ProviderKeyState } from '../api.ts';
import { useEscapeLayer } from '../hooks.ts';
import { useT } from '../i18n/index.ts';
import { isComposing } from '../keys.ts';
import { toast } from '../toast.tsx';
import { AccessConfirm } from './AccessConfirm.tsx';
import { keyEntryAccess, type Access } from './access.ts';
import { trimKey } from './model.ts';

interface Props {
  id: string;
  // 保存済みのプロバイダ。鍵は、サーバーが覚えているこの保存済みの送り先へ送られるので、確かめもこれで決める
  saved: Record<string, any> | undefined;
  // 保存済みで、編集中の変更が無い（鍵を入れられる）
  ready: boolean;
  // 同じ環境変数を使うほかのプロバイダ
  sharedWith: string[];
  // 鍵を入れた・消したあと（設定の apiKeyEnv とモデルの確認が変わりうる）
  onChanged: () => void;
  // 鍵の環境変数の名前が、鍵の名前として使えないときの、その名前（サーバーが鍵を書かない名前）
  unsafeEnv: string | undefined;
  // 「詳しい設定」（環境変数名の欄）を開く
  onOpenAdvanced: () => void;
}

// プロバイダの API キーの欄。入れたキーは画面に残さず、サーバーが .env に書く。入っているかと末尾 4 文字だけを見せる。
// 送り先がこの PC の外なら、送る先を並べて確かめてから送る
export function KeyField({ id, saved, ready, sharedWith, onChanged, unsafeEnv, onOpenAdvanced }: Props) {
  const t = useT();
  const [state, setState] = useState<ProviderKeyState | 'failed' | null>(null);
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Access[] | null>(null);

  useEffect(() => {
    setState(null); setValue(''); setEditing(false); setRemoving(false); setError(null); setConfirm(null);
    if (!ready || unsafeEnv) return undefined;
    let live = true;
    api.providerKey(id).then(next => { if (live) setState(next); }).catch(() => { if (live) setState('failed'); });
    return () => { live = false; };
  }, [id, ready, unsafeEnv]);
  useEscapeLayer('dialog', confirm !== null, () => setConfirm(null));

  async function submit(confirmed = false) {
    const key = trimKey(value);
    if (!key || busy || !saved) return;
    const widening = keyEntryAccess(saved);
    if (widening.length > 0 && !confirmed) { setConfirm(widening); return; }
    setConfirm(null); setBusy(true); setError(null);
    try {
      const next = await api.setProviderKey(id, key);
      setValue(''); setState(next); setEditing(false);
      toast({ kind: 'done', icon: 'check', title: t('settings.key.saved') });
      onChanged();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : t('settings.key.failed'));
    } finally { setBusy(false); }
  }

  async function remove() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const next = await api.deleteProviderKey(id);
      setState(next);
      setRemoving(false);
      // OS の環境変数にあるキーは、ここからは消せない（.env に書かれた分だけ消えた）
      toast(next.set ? { kind: 'info', icon: 'info', title: t('settings.key.stillSetOs') } : { kind: 'done', icon: 'check', title: t('settings.key.removed') });
      onChanged();
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : t('settings.key.failed'));
    } finally { setBusy(false); }
  }

  if (!ready) return <span className="set-note">{t('settings.key.needSave')}</span>;
  if (unsafeEnv) {
    return (
      <div className="set-keyfield">
        <span className="set-row-error" role="alert">{t('settings.key.unsafeEnv', unsafeEnv)}</span>
        <div className="set-keyrow"><button type="button" className="btn btn-secondary" onClick={onOpenAdvanced}>{t('settings.key.openAdvanced')}</button></div>
      </div>
    );
  }
  if (state === null) return <span className="set-note" role="status">{t('settings.loading')}</span>;
  const current = state === 'failed' ? undefined : state;
  const isSet = current?.set === true;
  const fromOs = isSet && current?.source === 'os';
  const showInput = (!isSet || editing) && !removing;
  return (
    <div className="set-keyfield">
      {state === 'failed' && <span className="set-note">{t('settings.key.loadFailed')}</span>}
      {!isSet && state !== 'failed' && <span className="set-note">{t('settings.key.unset')}</span>}
      {isSet && !editing && !removing && (
        <div className="set-keyrow">
          <span className="tag tag-neutral">{fromOs ? t('settings.key.setOs') : t('settings.key.set', current?.last4 ?? '')}</span>
          <button type="button" className="btn btn-secondary" onClick={() => setEditing(true)}>{t('settings.key.replace')}</button>
          {!fromOs && <button type="button" className="btn btn-ghost" onClick={() => setRemoving(true)}>{t('settings.key.remove')}</button>}
        </div>
      )}
      {isSet && removing && (
        <div className="set-keyrow">
          <span className="set-note">{t('settings.key.removeAsk')}</span>
          <button type="button" className="btn btn-secondary" onClick={() => void remove()} disabled={busy}>{t('settings.key.remove')}</button>
          <button type="button" className="btn btn-ghost" onClick={() => setRemoving(false)} disabled={busy}>{t('settings.key.cancel')}</button>
        </div>
      )}
      {showInput && (
        <div className="set-keyrow">
          <input
            type="password" className="input set-text mono" value={value} placeholder={t('settings.key.placeholder')} aria-label={t('settings.key.label')}
            autoComplete="new-password" spellCheck={false} disabled={busy}
            onChange={e => { setValue(e.target.value); setError(null); }}
            onKeyDown={e => { if (e.key === 'Enter' && !isComposing({ isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode })) void submit(); }}
          />
          <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={busy || trimKey(value) === ''}>{busy ? t('settings.key.saving') : t('settings.key.save')}</button>
          {isSet && <button type="button" className="btn btn-ghost" onClick={() => { setEditing(false); setValue(''); setError(null); }} disabled={busy}>{t('settings.key.cancel')}</button>}
        </div>
      )}
      {fromOs && <span className="set-note">{t('settings.key.osNote')}</span>}
      {error && <span className="set-row-error" role="alert">{error}</span>}
      {sharedWith.length > 0 && <span className="set-row-desc">{t('settings.key.shared', sharedWith.join(', '))}</span>}
      {confirm && (
        <div className="set-widen-inline">
          <AccessConfirm items={confirm} busy={busy} title={t('settings.key.confirmTitle')} ok={t('settings.key.confirmOk')} onCancel={() => setConfirm(null)} onConfirm={() => void submit(true)} />
        </div>
      )}
    </div>
  );
}
