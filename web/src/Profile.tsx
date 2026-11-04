import { useEffect, useState } from 'react';
import { api, ApiError, type Motion, type Profile } from './api.ts';
import { Avatar } from './Avatar.tsx';

const MOTION_LABEL: Record<Motion, string> = { auto: '自動（様子に合わせる）', none: 'なし', float: 'ふわふわ', sway: 'ゆらゆら', pulse: '脈打つ' };

export function ProfileEditor({ onSaved }: { onSaved: (p: Profile) => void }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [draft, setDraft] = useState<Pick<Profile, 'name' | 'shape' | 'color' | 'motion'> | null>(null);
  const [message, setMessage] = useState('');
  useEffect(() => { void api.profile().then(p => { setProfile(p); setDraft({ name: p.name, shape: p.shape, color: p.color, motion: p.motion }); }); }, []);
  if (!profile || !draft) return null;
  const changed = draft.name !== profile.name || draft.shape !== profile.shape || draft.color !== profile.color || draft.motion !== profile.motion;
  const save = () => {
    setMessage('');
    void api.saveProfile(draft).then(p => { setProfile(p); onSaved(p); setMessage('保存しました'); }, e => setMessage(e instanceof ApiError ? e.message : '保存できませんでした'));
  };
  return (
    <div className="profile-editor">
      <div className="avatar-preview">
        <Avatar shape={draft.shape} color={draft.color} motion={draft.motion} preview size={72} seed={draft.name} />
        <div className="row wrap">
          <label>名前 <input value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} maxLength={40} /></label>
          <label>色 <input type="color" value={draft.color} onChange={e => setDraft({ ...draft, color: e.target.value.toUpperCase() })} /></label>
          <label>動き <select value={draft.motion} onChange={e => setDraft({ ...draft, motion: e.target.value as Motion })}>
            {profile.motions.map(m => <option key={m} value={m}>{MOTION_LABEL[m]}</option>)}
          </select></label>
        </div>
      </div>
      <div className="shape-picker" role="radiogroup" aria-label="形">
        {profile.shapes.map(shape => (
          <button key={shape} type="button" role="radio" aria-checked={draft.shape === shape} aria-label={shape} title={shape}
            className={`shape-option ${draft.shape === shape ? 'selected' : ''}`} onClick={() => setDraft({ ...draft, shape })}>
            <Avatar shape={shape} color={draft.color} motion="none" size={36} />
          </button>
        ))}
      </div>
      <div className="row">
        <button onClick={save} disabled={!changed || !draft.name.trim()}>保存</button>
        {message && <span className="muted">{message}</span>}
      </div>
    </div>
  );
}
