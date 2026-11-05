import type { Language } from '../config/schema.ts';
import type { ChatMessage } from './types.ts';

interface EngineText {
  summaryHeading: string;
  compactSystem: string;
  compactInstructions: readonly string[];
  compactPreviousHeading: string;
  compactTranscriptHeading: string;
  user: string;
  toolResult: (name: string) => string;
  wrapUpSystem: string;
  wrapUpInstructions: readonly string[];
  wrapUpTranscriptHeading: string;
  doneHeading: string;
  nextHeading: string;
}

const TEXT: Record<Language, EngineText> = {
  ja: {
    summaryHeading: '# これまでの会話の要約（古い部分。原文は history_read で読めます）',
    compactSystem: 'あなたは会話の要約係です。指示されたとおりに要約だけを書きます。',
    compactInstructions: [
      'これは会話の古い部分です。これからの会話を続けるのに必要なことを、日本語の箇条書きで簡潔にまとめてください。',
      '残すもの: ユーザーの目的・頼まれていること・決まったこと・分かった事実・まだ終わっていないこと・大事な固有名詞や数値。',
      '残さないもの: あいさつ・言い回し・試行錯誤の細部。',
    ],
    compactPreviousHeading: '# これまでの要約（これに足して、まとめ直してください）',
    compactTranscriptHeading: '# 会話の古い部分',
    user: 'ユーザー',
    toolResult: name => `道具（${name}）の結果`,
    wrapUpSystem: 'あなたは作業の引き継ぎ係です。指示されたとおりに、短い引き継ぎのメモだけを書きます。道具は使えません。',
    wrapUpInstructions: [
      'ここまでの作業は、道具を使う回数の上限に達したため途中で止まりました。次の 2 つだけを、日本語で短く（全体で 10 行以内）書いてください。',
      '「ここまでにやったこと」: 実際に終わったこと（書いたファイル・分かった事実を含む）。',
      '「次の一手」: 続けるなら、最初に何をするか。',
      '見ていないこと・やっていないことを、やったことにしないでください。',
    ],
    wrapUpTranscriptHeading: '# ここまでの作業の記録',
    doneHeading: 'ここまでにやったこと',
    nextHeading: '次の一手',
  },
  en: {
    summaryHeading: '# Summary of the conversation so far (the older part; the original text can be read with history_read)',
    compactSystem: 'You are a conversation summarizer. Write only the summary, exactly as instructed.',
    compactInstructions: [
      'This is the older part of a conversation. Summarize, concisely as bullet points in English, what is needed to continue the conversation from here.',
      "Keep: the user's goals, what they asked for, what was decided, facts that were found, what is not finished yet, and important proper nouns and numbers.",
      'Drop: greetings, turns of phrase, and the details of trial and error.',
    ],
    compactPreviousHeading: '# Summary so far (add to this and rewrite it as one summary)',
    compactTranscriptHeading: '# Older part of the conversation',
    user: 'User',
    toolResult: name => `Result of tool (${name})`,
    wrapUpSystem: 'You write handover notes. Write only a short handover note, exactly as instructed. You cannot use tools.',
    wrapUpInstructions: [
      'The work so far stopped partway because the tool-call limit was reached. Write only the following two parts, briefly in English (10 lines or fewer in total).',
      '"Done so far": what was actually finished (including files written and facts found).',
      '"Next step": what to do first if the work continues.',
      'Do not present things you have not seen or done as done.',
    ],
    wrapUpTranscriptHeading: '# Record of the work so far',
    doneHeading: 'Done so far',
    nextHeading: 'Next step',
  },
};

export function summarySection(summary: string, language: Language): string {
  return summary ? `${TEXT[language].summaryHeading}\n${summary}` : '';
}

export function compactSystem(language: Language): string {
  return TEXT[language].compactSystem;
}

export function wrapUpSystem(language: Language): string {
  return TEXT[language].wrapUpSystem;
}

export function wrapUpPrompt(transcript: string, language: Language): string {
  const text = TEXT[language];
  return [...text.wrapUpInstructions, `\n${text.wrapUpTranscriptHeading}\n${transcript}`, `\n${text.doneHeading}:`].join('\n');
}

const NEXT_STEP = /(?:^|\n)[ \t]*(?:(?:#{1,6}|[-*+])[ \t]+)?[*_「『"“'`]*(?:次の一手|Next steps?)[*_」』"”'`]*[ \t]*(?:[:：][*_」』"”'`]*|\r?\n)([\s\S]+)$/iu;

// まとめの「次の一手」の部分（見出しの後ろ）。見出しは「」・""・**・先頭の # や - で飾ってよく、コロンは無くてもよい（中身は同じ行でも次の行でも）。見つからなければ undefined
export function nextStepOf(summary: string): string | undefined {
  const step = NEXT_STEP.exec(summary)?.[1]?.trim();
  return step ? step.slice(0, 500) : undefined;
}

export function compactSpeaker(message: { role: string; name?: string }, language: Language): string {
  const text = TEXT[language];
  return message.role === 'user' ? text.user : message.role === 'assistant' ? 'Clive' : text.toolResult(message.name ?? '');
}

export function compactPrompt(input: { previous: string | null; transcript: string }, language: Language): string {
  const text = TEXT[language];
  return [
    ...text.compactInstructions,
    input.previous ? `\n${text.compactPreviousHeading}\n${input.previous}` : '',
    `\n${text.compactTranscriptHeading}\n${input.transcript}`,
  ].join('\n');
}

const REPLY_REMINDER: Record<Language, string> = {
  ja: '[システムからの注意: この会話の返事の言語は日本語になりました。これまでの返事が英語でも、日本語で返事を書いてください。ユーザーが別の言語で話しかけたら、その言語で返してください。]',
  en: '[System note: the reply language of this conversation is now English. Write your reply in English even if your earlier replies were in Japanese. If the user writes to you in another language, reply in that language.]',
};

export function snapshotLanguageKey(conversationId: string): string {
  return `snapshot-language:${conversationId}`;
}

export function replyLanguageKey(conversationId: string): string {
  return `reply-language:${conversationId}`;
}

export function withReplyReminder(messages: readonly ChatMessage[], language: Language): ChatMessage[] {
  const copy = [...messages];
  const index = copy.findLastIndex(m => m.role === 'user');
  const target = copy[index];
  if (target?.role === 'user') copy[index] = { ...target, content: `${target.content}\n\n${REPLY_REMINDER[language]}` };
  return copy;
}
