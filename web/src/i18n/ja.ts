export const ja = {
  'nav.newChat': '＋ 新しい会話',
  'nav.today': 'きょう',
  'nav.tasks': 'タスク',
  'nav.notifications': '通知',
  'nav.review': 'レビュー',
  'nav.memory': '記憶',
  'nav.skills': 'スキル',
  'nav.curiosity': '好奇心',
  'nav.settings': '設定',
  'nav.runs': '実行ログ',
  'nav.tasksWaiting': (n: number) => `返事待ち ${n}`,

  'conversation.untitled': '（無題）',
  'conversation.needsApproval': '承認待ち',
  'conversation.needsApprovalTip': '承認が必要です',
  'conversation.generating': '返事を作っています',

  'connection.on': '接続中',
  'connection.off': '切断中（自動で繋ぎ直します）',

  'notice.modelSwitch': (from: string, to: string, reason: string) => `${from} が使えなかったため ${to} に切り替えました（${reason}）`,
  'notice.toolDenied': (name: string, detail: string) => `「${name}」は実行しませんでした: ${detail}`,
  'notice.memoryCreate': (content: string) => `記憶しました: ${content}`,
  'notice.memoryUpdate': (content: string) => `記憶を書き直しました: ${content}`,
  'notice.memoryForget': (content: string) => `記憶を消しました: ${content}`,
  'notice.runFailed': (reason: string) => `返事を作れませんでした: ${reason}`,

  'browser.approvalNeeded': 'Clive: 承認が必要です',
  'browser.notification': (title: string) => `Clive: ${title}`,

  'weekday.mon': '月曜',
  'weekday.tue': '火曜',
  'weekday.wed': '水曜',
  'weekday.thu': '木曜',
  'weekday.fri': '金曜',
  'weekday.sat': '土曜',
  'weekday.sun': '日曜',

  'time.zoneNote': (zone: string) => `時刻は ${zone} で表示しています`,
  'time.inputZone': (zone: string) => `この日時は ${zone} の時刻です`,

  'settings.appearance': '見た目',
  'settings.language': '表示の言語',
  'settings.language.auto': 'ブラウザに合わせる',
  'settings.language.hint': 'この画面の言語です。Clive の返事の言語は、まだ変わりません。',
  'lang.ja': '日本語',
  'lang.en': 'English',
} as const;
