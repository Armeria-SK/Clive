export type ThemeMode = 'auto' | 'light' | 'dark';

const KEY = 'clive.theme';
const darkQuery = (): MediaQueryList | null =>
  typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

let current: ThemeMode = 'auto';

function load(): ThemeMode {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch { }
  return 'auto';
}

function apply(): void {
  const dark = current === 'dark' || (current === 'auto' && darkQuery()?.matches === true);
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
  const query = darkQuery();
  if (!query) return;
  if (typeof query.addEventListener === 'function') query.addEventListener('change', apply);
  else if (typeof query.addListener === 'function') query.addListener(apply);
}
