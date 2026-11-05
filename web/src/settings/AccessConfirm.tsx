import { useEffect, useRef, type ReactNode } from 'react';
import { useT } from '../i18n/index.ts';
import type { Access } from './access.ts';

type Translate = ReturnType<typeof useT>;

const broadNote = (t: Translate, broad: 'filesystem' | 'home' | null): ReactNode => (broad ? <span className="sk-warn">{t(broad === 'filesystem' ? 'folders.confirm.filesystem' : 'folders.confirm.home')}</span> : null);

export function accessText(t: Translate, a: Access): ReactNode {
  const stage = (s: 'preToolUse' | 'postToolUse') => t(s === 'preToolUse' ? 'settings.tools.hookPre' : 'settings.tools.hookPost');
  const hook = (h: { matcher: string; command: string[] }) => `${h.matcher} → ${h.command.join(' ') || '—'}`;
  switch (a.kind) {
    case 'deny-removed': return <>{t('folders.confirm.denyRemoved', a.path)}{a.builtin && <span className="sk-warn">{t('folders.confirm.denyBuiltin')}</span>}</>;
    case 'root-added': return <>{t('folders.confirm.rootAdded', a.path, t(a.mode === 'write' ? 'folders.mode.write' : 'folders.mode.read'))}{broadNote(t, a.broad)}</>;
    case 'root-write': return <>{t('folders.confirm.rootWrite', a.path)}{broadNote(t, a.broad)}</>;
    case 'shell-enabled': return t('access.shellEnabled');
    case 'shell-allow-added': return <>{t('access.shellAllow', a.command)}{a.runsCode && <span className="sk-warn">{t('access.shellAllowCode')}</span>}</>;
    case 'shell-ask-removed': return t('access.shellAsk', a.command);
    case 'shell-deny-removed': return t('access.shellDeny', a.command);
    case 'shell-env-added': return t('access.shellEnv', a.name);
    case 'outside-loosened': return t('access.outside');
    case 'taint-off': return t('access.taintOff');
    case 'web-fetch-on': return t('access.webFetch');
    case 'web-search-on': return t('access.webSearch');
    case 'self-tasks-unapproved': return t('access.selfTasks');
    case 'hook-added': return t('access.hookAdded', stage(a.stage), hook(a.hook));
    case 'hook-edited': return t('access.hookEdited', stage(a.stage), hook(a.hook));
    case 'hook-removed': return t('access.hookRemoved', stage(a.stage), hook(a.hook));
    case 'origin-added': return t('access.origin', a.origin);
    case 'login-added': return t('access.login', a.login);
    case 'logins-cleared': return t('access.loginsCleared');
    case 'host-exposed': return t('access.host', a.host);
    case 'provider-url': return t('access.providerUrl', a.id, a.url);
    case 'provider-key': return t('access.providerKey', a.id, a.env);
    case 'searxng-url': return t('access.searxng', a.url);
  }
}

const itemKey = (a: Access, i: number): string => `${a.kind}:${'path' in a ? a.path : ''}:${i}`;

// 範囲を広げる保存の確認。広がるものをそのまま並べて、「広げて保存する」を押したときだけ書く。
export function AccessConfirm({ items, busy, onCancel, onConfirm }: { items: readonly Access[]; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const t = useT();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancel.current?.focus(); }, []);
  return (
    <div className="set-widen" role="alertdialog" aria-label={t('folders.confirm.title')}>
      <strong>{t('folders.confirm.title')}</strong>
      <ul>{items.map((a, i) => <li key={itemKey(a, i)}>{accessText(t, a)}</li>)}</ul>
      <div className="set-widen-actions">
        <button ref={cancel} className="btn btn-ghost" onClick={onCancel}>{t('folders.confirm.cancel')}</button>
        <button className="btn btn-primary" onClick={onConfirm} disabled={busy}>{t('folders.confirm.ok')}</button>
      </div>
    </div>
  );
}
