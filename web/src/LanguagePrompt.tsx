import { useState } from 'react';
import { getLanguage, getLanguagePreference, useT } from './i18n/index.ts';
import { loadPromptAnswer, savePromptAnswer, saveLanguage, shouldAskLanguage } from './language.ts';
import { toast } from './toast.tsx';

export function LanguagePrompt() {
  const t = useT();
  const [answered, setAnswered] = useState(() => loadPromptAnswer() !== null);
  const [busy, setBusy] = useState(false);
  const screen = getLanguage();
  if (!shouldAskLanguage({ serverLanguage: getLanguagePreference(), screenLanguage: screen, answered })) return null;

  const decline = () => { savePromptAnswer('no'); setAnswered(true); };
  const accept = async () => {
    setBusy(true);
    try {
      await saveLanguage(screen);
      savePromptAnswer('yes');
      setAnswered(true);
    } catch {
      toast({ title: t('toast.actionFailed'), icon: 'alert' });
    } finally { setBusy(false); }
  };

  return (
    <div className="lang-prompt" role="region" aria-label={t('settings.language')}>
      <span className="lang-prompt-text">{t('langPrompt.text', t(screen === 'en' ? 'lang.en' : 'lang.ja'))} <span className="lang-prompt-hint">{t('langPrompt.hint')}</span></span>
      <button className="btn btn-primary" disabled={busy} onClick={() => void accept()}>{t('langPrompt.yes')}</button>
      <button className="btn btn-ghost" disabled={busy} onClick={decline}>{t('langPrompt.no')}</button>
    </div>
  );
}
