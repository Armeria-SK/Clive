import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/ibm-plex-sans-jp/400.css';
import '@fontsource/ibm-plex-sans-jp/500.css';
import '@fontsource/ibm-plex-sans-jp/600.css';
import { api } from './api.ts';
import { App } from './App.tsx';
import { initLanguage, loadServerSettings } from './i18n/index.ts';
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
  await loadServerSettings(api.settings);
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
}

void start();
