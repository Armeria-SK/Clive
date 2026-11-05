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
import { initLanguage, loadTimezone } from './i18n/index.ts';
import './styles/tokens.css';
import './styles.css';
import './styles/components.css';
import './styles/shell.css';
import './styles/skills.css';
import './styles/logs.css';
import './styles/tasks.css';
import './styles/chat.css';
import { initTheme } from './theme.ts';

async function start(): Promise<void> {
  initTheme();
  initLanguage();
  await loadTimezone(api.settings);
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
}

void start();
