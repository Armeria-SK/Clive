import { useId, type CSSProperties } from 'react';
import { avatarMotion, avatarParts, blinkTiming, type AvatarParts, type Runtime } from './avatar.ts';

// 形の SVG はビルド時に文字列として取り込み、体と目に分けておく
const SHAPE_PARTS: Record<string, AvatarParts> = Object.fromEntries(
  Object.entries(import.meta.glob('./avatars/avatar-*.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
    .map(([path, svg]) => [/avatar-([a-z]+)\.svg$/u.exec(path)![1]!, avatarParts(svg)]),
);

interface Props {
  shape: string;
  color: string;
  motion: string;
  runtime?: Runtime;
  sleeping?: boolean;
  preview?: boolean;
  size?: number;
  seed?: string;
}

export function Avatar({ shape, color, motion, runtime, sleeping, preview, size = 48, seed = 'clive' }: Props) {
  const mask = `avatar-${useId().replace(/[^a-zA-Z0-9_-]/gu, '')}`;
  const parts = SHAPE_PARTS[shape] ?? SHAPE_PARTS.pebble!;
  const animation = avatarMotion({ preference: motion, ...(runtime ? { runtime } : {}), sleeping: Boolean(sleeping), preview: Boolean(preview) });
  const blink = blinkTiming(seed);
  const style = { width: size, height: size, '--blink-period': `${blink.period}s`, '--blink-delay': `${blink.delay}s` } as CSSProperties;
  return (
    <svg className="bot-avatar" data-motion={animation} aria-hidden="true" focusable="false" viewBox="0 0 100 100" width={size} height={size} style={style}>
      <mask id={mask}>
        <path d={parts.body} fill="#fff" />
        {parts.eyes.map((eye, index) => <path key={index} className="bot-eye" d={eye} fill="#000" />)}
      </mask>
      <rect width="100" height="100" fill={color} mask={`url(#${mask})`} />
    </svg>
  );
}

export const SHAPE_NAMES = Object.keys(SHAPE_PARTS);
