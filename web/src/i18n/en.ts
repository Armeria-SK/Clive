import type { Dict } from './types.ts';

export const en: Dict = {
  'nav.newChat': '+ New chat',
  'nav.today': 'Today',
  'nav.tasks': 'Tasks',
  'nav.notifications': 'Notifications',
  'nav.review': 'Review',
  'nav.memory': 'Memory',
  'nav.skills': 'Skills',
  'nav.curiosity': 'Curiosity',
  'nav.settings': 'Settings',
  'nav.runs': 'Run log',
  'nav.tasksWaiting': n => `${n} awaiting reply`,

  'conversation.untitled': '(Untitled)',
  'conversation.needsApproval': 'Needs approval',
  'conversation.needsApprovalTip': 'Approval needed',
  'conversation.generating': 'Writing a reply',

  'connection.on': 'Connected',
  'connection.off': 'Disconnected (reconnecting automatically)',

  'notice.modelSwitch': (from, to, reason) => `${from} was unavailable, so Clive switched to ${to} (${reason})`,
  'notice.toolDenied': (name, detail) => `Did not run "${name}": ${detail}`,
  'notice.memoryCreate': content => `Remembered: ${content}`,
  'notice.memoryUpdate': content => `Rewrote a memory: ${content}`,
  'notice.memoryForget': content => `Forgot a memory: ${content}`,
  'notice.runFailed': reason => `Could not write a reply: ${reason}`,

  'browser.approvalNeeded': 'Clive: Approval needed',
  'browser.notification': title => `Clive: ${title}`,

  'weekday.mon': 'Monday',
  'weekday.tue': 'Tuesday',
  'weekday.wed': 'Wednesday',
  'weekday.thu': 'Thursday',
  'weekday.fri': 'Friday',
  'weekday.sat': 'Saturday',
  'weekday.sun': 'Sunday',

  'time.zoneNote': zone => `Times are shown in ${zone}`,
  'time.inputZone': zone => `This date and time is in ${zone}`,

  'settings.appearance': 'Appearance',
  'settings.language': 'Display language',
  'settings.language.auto': 'Match the browser',
  'settings.language.hint': "This changes the language of this screen only. Clive's replies do not change yet.",
  'lang.ja': '日本語',
  'lang.en': 'English',
};
