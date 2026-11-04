export type ThemeMode = 'auto' | 'light' | 'dark';

const KEY = 'clive.theme';
const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)');

let current: ThemeMode = 'auto';

function load(): ThemeMode {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { }
  return 'auto';
}

function apply(): void {
  const dark = current === 'dark' || (current === 'auto' && darkQuery().matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function getThemeMode(): ThemeMode {
  return current;
}

export function setThemeMode(mode: ThemeMode): void {
  current = mode;
  try { localStorage.setItem(KEY, mode); } catch { }
  apply();
}

export function initTheme(): void {
  current = load();
  apply();
  darkQuery().addEventListener('change', apply);
}
