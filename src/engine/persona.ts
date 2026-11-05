import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from '../config/store.ts';
import { LANGUAGES, type Language } from '../config/schema.ts';
import type { AppPaths } from '../paths.ts';
import { readTemplate } from './workspace.ts';

export const PERSONA_FILES = ['SOUL.md', 'USER.md'] as const;
export type PersonaFile = (typeof PERSONA_FILES)[number];
export const PERSONA_MAX_CHARS = 20_000;
export const NAME_MAX_CHARS = 40;
export const USER_NAME_MAX_CHARS = 80;
export const STYLE_NOTE_MAX_CHARS = 1000;

export const STYLES = ['calm', 'friendly', 'direct', 'none'] as const;
export type Style = (typeof STYLES)[number];

type Section = 'userBasic' | 'soulName' | 'soulStyle';

const HEADINGS: Record<Section, Record<Language, string>> = {
  userBasic: { ja: '基本情報', en: 'Basic information' },
  soulName: { ja: '名前', en: 'Name' },
  soulStyle: { ja: '話し方', en: 'Way of speaking' },
};

const USER_LABELS: Record<'name' | 'call' | 'language', Record<Language, string>> = {
  name: { ja: '名前', en: 'Name' },
  call: { ja: '呼び方', en: 'Preferred name' },
  language: { ja: '主な使用言語', en: 'Main language' },
};
const LANGUAGE_NAME: Record<Language, Record<Language, string>> = {
  ja: { ja: '日本語', en: 'Japanese' },
  en: { ja: '英語', en: 'English' },
};

const STYLE_TEXT: Record<Exclude<Style, 'none'>, Record<Language, string>> = {
  calm: {
    ja: '落ち着いて簡潔に話す。前置きや大げさな言い回しを避け、結論を先に、必要なことだけを伝える。',
    en: 'Speak calmly and concisely. Skip preambles and grand phrasing; give the conclusion first and only what is needed.',
  },
  friendly: {
    ja: '親しみやすく丁寧に話す。やわらかい言葉づかいで、相手の気持ちに寄り添いながら、分かりやすく説明する。',
    en: 'Speak in a friendly, polite way. Use gentle wording, stay close to how the person feels, and explain things clearly.',
  },
  direct: {
    ja: '率直に、短く話す。できる・できないをはっきり言い、遠回しな表現や長い説明は避ける。',
    en: 'Speak frankly and briefly. Say plainly what you can and cannot do, and avoid roundabout phrasing and long explanations.',
  },
};

export class PersonaError extends Error {
  readonly code: 'persona_unsafe';
  readonly file: string;
  constructor(code: 'persona_unsafe', file: string) {
    super(`${code}: ${file}`);
    this.code = code;
    this.file = file;
  }
}

export interface PersonaInput {
  userName?: string;
  callMe?: string;
  botName?: string;
  style?: Style;
  styleNote?: string;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const languagesFirst = (language: Language): Language[] => [language, ...LANGUAGES.filter(l => l !== language)];

interface Span { bodyStart: number; end: number }

// 見出し（## ...）は、今の言語の見出しを先に、なければほかの言語の見出しも探す（日本語で作ったファイルを英語に切り替えても同じ節を直す）。
function findSection(lf: string, section: Section, language: Language): Span | null {
  for (const lang of languagesFirst(language)) {
    const heading = new RegExp(`^##[ \\t]+${escapeRegExp(HEADINGS[section][lang])}[ \\t]*$`, 'mu').exec(lf);
    if (!heading) continue;
    const bodyStart = heading.index + heading[0].length + (lf[heading.index + heading[0].length] === '\n' ? 1 : 0);
    const next = /^#{1,2}[ \t]/mu.exec(lf.slice(bodyStart));
    return { bodyStart, end: next ? bodyStart + next.index : lf.length };
  }
  return null;
}

function setSectionBody(lf: string, section: Section, language: Language, body: string): string {
  const span = findSection(lf, section, language);
  const text = body.trim();
  if (!span) return `${lf.replace(/\n*$/u, '\n')}\n## ${HEADINGS[section][language]}\n\n${text}\n`;
  const before = lf.slice(0, span.bodyStart);
  const after = lf.slice(span.end);
  return `${before}\n${text ? `${text}\n` : ''}${after ? '\n' : ''}${after}`;
}

function labelPattern(key: 'name' | 'call'): RegExp {
  const labels = LANGUAGES.map(l => escapeRegExp(USER_LABELS[key][l])).join('|');
  return new RegExp(`^-[ \\t]*(?:${labels})[ \\t]*[:：]`, 'u');
}

// USER.md の基本情報の節は、名前と呼び方の行だけを書き換える（持ち主が足したほかの行は残す）。
function setUserLines(lf: string, language: Language, values: { name?: string | undefined; call?: string | undefined }): string {
  const span = findSection(lf, 'userBasic', language);
  const lines = span ? lf.slice(span.bodyStart, span.end).split('\n').filter((line, i, all) => line.trim() || (i > 0 && i < all.length - 1)) : [];
  const keep = lines.filter(line => line.trim() !== '');
  const upsert = (key: 'name' | 'call', value: string | undefined): void => {
    if (value === undefined) return;
    const line = `- ${USER_LABELS[key][language]}: ${value}`;
    const at = keep.findIndex(l => labelPattern(key).test(l));
    if (at >= 0) { keep[at] = line; return; }
    const nameAt = key === 'call' ? keep.findIndex(l => labelPattern('name').test(l)) : -1;
    if (nameAt >= 0) keep.splice(nameAt + 1, 0, line);
    else keep.unshift(line);
  };
  upsert('name', values.name);
  upsert('call', values.call);
  if (!span && !keep.some(l => /^-[ \t]*(?:主な使用言語|Main language)/u.test(l))) keep.push(`- ${USER_LABELS.language[language]}: ${LANGUAGE_NAME[language][language]}`);
  return setSectionBody(lf, 'userBasic', language, keep.join('\n'));
}

const oneLine = (value: string): string => value.replace(/[\r\n\t]+/gu, ' ').replace(/ {2,}/gu, ' ').trim();
// 名前の先頭の # は見出しになりうるので、受け付けない（route が 400 にする）。ここでも念のため印を付ける。
export const startsWithHash = (value: string): boolean => oneLine(value).startsWith('#');
const cleanLine = (value: string): string => { const text = oneLine(value); return text.startsWith('#') ? `\\${text}` : text; };
// 自由な文の、見出しになる行（先頭の 3 字までの空白 + #）と、直前の行を見出しにする下線（= か - だけの行）には印を付ける。
const HEADING_LINE = /^(\s{0,3})#/u;
const SETEXT_LINE = /^(\s{0,3})(?:=+|-+)\s*$/u;
const cleanBlock = (value: string): string => value.replace(/\r\n/gu, '\n').split('\n')
  .map(line => (HEADING_LINE.test(line) ? line.replace(HEADING_LINE, '$1\\#') : SETEXT_LINE.test(line) ? line.replace(/^(\s{0,3})/u, '$1\\') : line)).join('\n').trim();

export function styleText(style: Style, language: Language): string {
  return style === 'none' ? '' : STYLE_TEXT[style][language];
}

function eolOf(text: string): string { return text.includes('\r\n') ? '\r\n' : '\n'; }
const toLf = (text: string): string => text.replace(/\r\n/gu, '\n');
const withEol = (lf: string, eol: string): string => (eol === '\n' ? lf : lf.replace(/\n/gu, eol));

// 名前・呼び方・話し方の節だけを書き換えた SOUL.md / USER.md の全文を返す（書き込みはしない）。
export function personaTexts(soul: string, user: string, language: Language, input: PersonaInput): { soul: string; user: string } {
  let soulLf = toLf(soul);
  let userLf = toLf(user);
  if (input.botName !== undefined) soulLf = setSectionBody(soulLf, 'soulName', language, input.botName);
  if (input.style !== undefined || input.styleNote !== undefined) {
    const parts = [input.style ? styleText(input.style, language) : '', input.styleNote ? cleanBlock(input.styleNote) : ''].filter(Boolean);
    soulLf = setSectionBody(soulLf, 'soulStyle', language, parts.join('\n\n'));
  }
  if (input.userName !== undefined || input.callMe !== undefined) userLf = setUserLines(userLf, language, { name: input.userName, call: input.callMe });
  return { soul: withEol(soulLf, eolOf(soul)), user: withEol(userLf, eolOf(user)) };
}

export function normalizePersonaInput(input: PersonaInput): PersonaInput {
  return {
    ...(input.userName !== undefined ? { userName: cleanLine(input.userName).slice(0, USER_NAME_MAX_CHARS) } : {}),
    ...(input.callMe !== undefined ? { callMe: cleanLine(input.callMe).slice(0, USER_NAME_MAX_CHARS) } : {}),
    ...(input.botName !== undefined ? { botName: cleanLine(input.botName).slice(0, NAME_MAX_CHARS) } : {}),
    ...(input.style !== undefined ? { style: input.style } : {}),
    ...(input.styleNote !== undefined ? { styleNote: input.styleNote } : {}),
  };
}

function readOrEmpty(path: string): string {
  try { return readFileSync(path, 'utf8'); } catch (error) { if (['ENOENT', 'EISDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return ''; throw error; }
}

export function readPersona(paths: AppPaths): { soul: string; user: string } {
  return { soul: readOrEmpty(join(paths.workspace, 'SOUL.md')), user: readOrEmpty(join(paths.workspace, 'USER.md')) };
}

// 書く先の作業フォルダとファイルが、リンク（シンボリックリンク・ジャンクション）や普通のファイルでないときは断る（リンクの先の別のファイルを書き換えさせない）。
function assertWritable(paths: AppPaths, name: PersonaFile): string {
  const target = join(paths.workspace, name);
  for (const path of [paths.workspace, target]) {
    let stat;
    try { stat = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink() || (path === target && !stat.isFile()) || (path === paths.workspace && !stat.isDirectory())) throw new PersonaError('persona_unsafe', name);
  }
  return target;
}

// 書く前の控えは、作業フォルダの中ではなく data/backups/persona/ に置く（Clive の道具から触れない場所）。
export function writePersonaFile(paths: AppPaths, name: PersonaFile, content: string, now = Date.now()): void {
  const target = assertWritable(paths, name);
  const existing = readOrEmpty(target);
  if (existing !== content) {
    if (existing) {
      const dir = join(paths.backups, 'persona');
      mkdirSync(dir, { recursive: true });
      copyFileSync(target, join(dir, `${name}.${new Date(now).toISOString().replace(/[:.]/gu, '-')}.bak`));
      pruneBackups(dir, name);
    }
    atomicWriteFile(target, content);
  }
}

// 書く前の控えは、ファイルごとに新しいものから 20 個まで残す（古いものから消す。時刻の並びは文字の並びと同じ）。
export const PERSONA_BACKUPS_KEPT = 20;
function pruneBackups(dir: string, name: PersonaFile): void {
  const files = readdirSync(dir).filter(file => file.startsWith(`${name}.`) && file.endsWith('.bak')).sort();
  for (const file of files.slice(0, Math.max(0, files.length - PERSONA_BACKUPS_KEPT))) unlinkSync(join(dir, file));
}

const normalized = (text: string): string => toLf(text).trim();

// 初期の文（日本語・英語どちらの初期ファイル）と同じなら、まだ何も書き換えていない。
export function isInitialPersona(paths: AppPaths, name: PersonaFile, current: string): boolean {
  const text = normalized(current);
  if (!text) return true;
  return LANGUAGES.some(language => normalized(readTemplate(paths, name, language)) === text);
}
