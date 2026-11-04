import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/cormorant-garamond/400.css';
import '@fontsource/cormorant-garamond/600.css';
import '@fontsource/lora/400.css';
import '@fontsource/lora/600.css';
import '@fontsource/noto-serif-jp/400.css';
import '@fontsource/noto-serif-jp/500.css';
import '@fontsource/noto-serif-jp/600.css';
import { App } from './App.tsx';
import './styles/tokens.css';
import './styles.css';
import './styles/components.css';
import { initTheme } from './theme.ts';

initTheme();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
