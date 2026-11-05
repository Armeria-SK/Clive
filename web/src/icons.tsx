import { PATHS, type IconName } from './icon-paths.ts';

export type { IconName };

export function Icon({ name, size = '1em' }: { name: IconName; size?: number | string }) {
  return (
    <svg
      viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: PATHS[name] }}
    />
  );
}
