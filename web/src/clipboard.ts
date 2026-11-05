export interface CopyEnv {
  clipboard?: Pick<Clipboard, 'writeText'> | undefined;
  selectionCopy?: (text: string) => boolean;
}

// http（Tailscale のアドレスなど）の画面では navigator.clipboard が使えないので、選択してコピーする方法に切り替える。
// コピーできたかどうかを返す（できていないのに「コピーしました」と言わないため）。
export async function copyText(text: string, env: CopyEnv = {}): Promise<boolean> {
  const clipboard = 'clipboard' in env ? env.clipboard : typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard) {
    try { await clipboard.writeText(text); return true; } catch { }
  }
  return (env.selectionCopy ?? copyBySelection)(text);
}

function copyBySelection(text: string): boolean {
  if (typeof document === 'undefined') return false;
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.append(area);
  area.select();
  try { return document.execCommand('copy'); } catch { return false; } finally { area.remove(); previous?.focus(); }
}
