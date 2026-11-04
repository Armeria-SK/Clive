import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/cormorant-garamond/400.css';
import '@fontsource/cormorant-garamond/600.css';
import '@fontsource/lora/400.css';
import '@fontsource/lora/600.css';
import '@fontsource/noto-serif-jp/400.css';
import '@fontsource/noto-serif-jp/500.css';
import '@fontsource/noto-serif-jp/600.css';
import { api } from './api.ts';
import { App } from './App.tsx';
import { initLanguage, setTimezone } from './i18n/index.ts';
import './styles/tokens.css';
import './styles.css';
import './styles/components.css';
import { initTheme } from './theme.ts';

const SETTINGS_WAIT_MS = 3000;

async function loadTimezone(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), SETTINGS_WAIT_MS); });
    const { config } = await Promise.race([api.settings(), timeout]);
    if (typeof config.timezone === 'string') setTimezone(config.timezone);
  } catch (error) {
    console.warn('Could not load the server settings; showing times in the default time zone', error);
  } finally { clearTimeout(timer); }
}

async function start(): Promise<void> {
  initTheme();
  initLanguage();
  await loadTimezone();
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
}

void start();
