// git の許可の一覧（security-self-api.md §11.3.3）。リポジトリの設定は MatchCtx.repo（git-repo.ts）が調べる。ここは引数と、サブコマンドごとの扱い。

import { Acc, isFlagLike, literal, parseGnu, type GnuSpec, type MatchCtx } from './allowlist-core.ts';
import type { Word } from './shell-lex.ts';

const REV = /^[A-Za-z0-9_./~^@{}:-]+$/u;

interface ReadSub { flags: string; numeric?: boolean; pos: 'rev' | 'path' | 's' | 'none'; patFlags?: readonly string[]; first?: string }
const READ: Record<string, ReadSub> = {
  status: { flags: '-s --short -b --branch --porcelain --porcelain=v1 --porcelain=v2 -u -uno -unormal -uall --untracked-files:opt --ignored -z', pos: 'path' },
  log: { numeric: true, pos: 'rev', flags: '--oneline -n:n --max-count:n --skip:n --since:s --until:s --after:s --before:s --author:s --committer:s --grep:s -i -p -u --patch --stat --shortstat --numstat --name-only --name-status --graph --decorate:opt --all --branches --tags --format:s --pretty:s --abbrev-commit --reverse --first-parent --follow --no-merges --merges -S:s -G:s --date:s --color=never --no-color -s --no-patch --no-ext-diff --no-textconv' },
  show: { numeric: true, pos: 'rev', flags: '--oneline -n:n --max-count:n --skip:n --since:s --until:s --after:s --before:s --author:s --committer:s --grep:s -i -p -u --patch --stat --shortstat --numstat --name-only --name-status --graph --decorate:opt --all --branches --tags --format:s --pretty:s --abbrev-commit --reverse --first-parent --follow --no-merges --merges -S:s -G:s --date:s --color=never --no-color -s --no-patch --no-ext-diff --no-textconv' },
  diff: { pos: 'rev', flags: '--stat --shortstat --numstat --name-only --name-status --cached --staged -w --ignore-all-space -b -U:n --unified:n --word-diff:opt --color=never --no-color --diff-filter:s --no-ext-diff --no-textconv --no-index' },
  blame: { pos: 'rev', flags: '-L:s -w -s -e -M -C --date:s --porcelain --line-porcelain' },
  'ls-files': { pos: 'path', flags: '-s -m -o -d -c -k -u -z --cached --deleted --modified --others --ignored --exclude-standard --stage --unmerged --killed --eol --full-name --error-unmatch --abbrev:opt --no-empty-directory --recurse-submodules' },
  'ls-tree': { pos: 'rev', flags: '-r -d -t -l -z --name-only --name-status --full-name --full-tree --abbrev:opt --long' },
  'rev-parse': { pos: 'rev', flags: '--show-toplevel --git-dir --absolute-git-dir --git-common-dir --is-inside-work-tree --is-bare-repository --abbrev-ref:opt --short:opt --verify -q --quiet --show-prefix --show-cdup --symbolic-full-name --symbolic' },
  'rev-list': { pos: 'rev', flags: '--count --max-count:n -n:n --all --branches --tags --reverse --first-parent --no-merges --merges --since:s --until:s --author:s --oneline --abbrev-commit --parents' },
  describe: { pos: 'rev', flags: '--tags --always --long --abbrev:n --dirty:opt --match:s --exact-match --contains --all' },
  shortlog: { pos: 'rev', flags: '-s -n -e --numbered --summary --email --since:s --until:s' },
  'merge-base': { pos: 'rev', flags: '--is-ancestor --octopus -a --all --fork-point' },
  'name-rev': { pos: 'rev', flags: '--name-only --tags --refs:s --all --always' },
  'show-ref': { pos: 'rev', flags: '--heads --tags -d --dereference --hash:opt -s --verify -q --quiet --abbrev:opt' },
  'for-each-ref': { pos: 's', flags: '--format:s --sort:s --count:n --merged:s --no-merged:s --contains:s --points-at:s' },
  'count-objects': { pos: 'none', flags: '-v -H --verbose --human-readable' },
  cherry: { pos: 'rev', flags: '-v' },
  'cat-file': { pos: 'rev', flags: '-t -s -p -e' },
  grep: { pos: 'path', flags: '-n -i -l -c -v -w -E -F -P -e:pat --cached --untracked --no-index', patFlags: ['-e'], first: 'pat' },
};

// 書くサブコマンド（ふつうの設定で、フックが動かないリポジトリならふつうの確かめ）。positional: 位置の引数の扱い
const WRITE_FLAGS = '-A --all -u --update -n --dry-run -v --verbose -f --force -q --quiet -m:s --message:s -a --amend --no-edit --no-verify -s --signoff --author:s --date:s --allow-empty -b:s -B:s -c:s -C:s --detach --ours --theirs --staged -W --worktree --source:s --soft --mixed --hard --keep --include-untracked -k --keep-index --no-ff --ff-only --squash --abort --continue --skip --no-commit --onto:s -d -D -r --cached --ignore-unmatch --check --stat --index -3 -R -p:n --whitespace:s --no-gpg-sign --rebase --no-rebase --list -l';
const WRITE: Record<string, 'read' | 'write' | 'none'> = {
  add: 'read', commit: 'read', rm: 'write', mv: 'write', checkout: 'write', switch: 'none', restore: 'write', reset: 'write', stash: 'none', merge: 'none',
  rebase: 'none', 'cherry-pick': 'none', revert: 'none', tag: 'none', branch: 'none', apply: 'read', am: 'read', notes: 'none',
};
const NET = new Set(['fetch', 'pull', 'clone', 'ls-remote', 'submodule', 'init', 'worktree']);

function positional(words: readonly Word[], ddAt: number, mode: 'rev' | 'path' | 's' | 'none' | 'read' | 'write', acc: Acc, cmd: string): void {
  words.forEach((w, i) => {
    const afterDd = i >= ddAt;
    if (mode === 'write') { acc.write(w); return; }
    if (mode === 'read' || mode === 'path' || afterDd) { acc.read(w); return; }
    if (mode === 's') return;
    if (w.dynamic) return;
    if (w.text !== '-' && !REV.test(w.text)) { acc.add('once', 'list.form', { cmd, detail: w.text }, true); return; }
    if (mode === 'none') return;
    const colon = w.text.indexOf(':');
    if (colon >= 0) {
      const path = w.text.slice(colon + 1);
      if (path) acc.read({ ...w, text: path });
      return;
    }
    acc.read(w);
  });
}

const spec = (sub: string, flags: string, over: Partial<GnuSpec> = {}): GnuSpec => ({ names: [`git ${sub}`], flags, pos: ['x…'], ...over });

export function runGit(words: Word[], acc: Acc, ctx: MatchCtx): void {
  const args = words.slice(1);
  if (args.length === 1 && literal(args[0]) && args[0]!.text === '--version') return;
  let i = 0;
  let dashC: Word | undefined;
  for (; i < args.length && isFlagLike(args[i]!); i++) {
    const t = args[i]!.text;
    if (t === '-C') {
      const v = args[++i];
      if (!v || dashC) { acc.add('once', 'list.form', { cmd: 'git', detail: '-C' }, true); return; }
      dashC = v;
      acc.read(v);
    } else if (t !== '--no-pager' && t !== '-P' && t !== '--no-optional-locks') { acc.add('once', 'list.flag', { cmd: 'git', flag: t }, true); return; }
  }
  const subWord = args[i];
  if (!subWord || !literal(subWord)) { acc.add('once', 'list.form', { cmd: 'git', detail: subWord?.text ?? '' }, true); return; }
  const sub = subWord.text;
  const rest = [words[0]!, ...args.slice(i + 1)];
  if (sub === 'version' && rest.length === 1) return;
  if (ctx.gitIsolated === false) { acc.add('once', 'list.git_old', {}, false); return; }
  const repo = ctx.repo(dashC && !dashC.dynamic ? dashC.text : undefined);
  if (dashC?.dynamic) { acc.add('once', 'list.form', { cmd: 'git', detail: dashC.text }, true); return; }
  if (repo.unreadable) { acc.add('once', 'list.git_unreadable', {}, false); return; }
  if (!repo.configOk) { acc.add('once', 'list.git_config', { key: repo.badKey }, false); return; }
  const readSub = READ[sub];
  if (readSub) {
    const p = parseGnu(spec(sub, readSub.flags, { numeric: readSub.numeric ?? false, ...(readSub.patFlags ? { patFlags: readSub.patFlags } : {}) }), rest, acc, ctx);
    const pos = readSub.first === 'pat' && !readSub.patFlags?.some(f => p.seen.has(f)) ? p.pos.slice(1) : p.pos;
    positional(pos, Math.max(0, p.ddAt - (p.pos.length - pos.length)), readSub.pos, acc, `git ${sub}`);
    return;
  }
  switch (sub) {
    case 'branch': case 'tag': {
      const listFlags = sub === 'branch'
        ? '-a -r -v -vv --list --show-current --merged --no-merged --contains:s --sort:s --format:s --color=never'
        : '-l --list -n:opt --sort:s --contains:s --merged:s --no-merged:s --format:s --points-at:s';
      const probe = new Acc();
      const p = parseGnu(spec(sub, listFlags), rest, probe, ctx);
      const listing = probe.reasons.length === 0 && (sub === 'branch' ? p.pos.length === 0 : p.pos.length <= 1 && (p.seen.has('-l') || p.seen.has('--list') || p.pos.length === 0));
      if (listing) { acc.reasons.push(...probe.reasons); positional(p.pos, p.ddAt, 's', acc, `git ${sub}`); return; }
      writeSub(sub, rest, acc, ctx, repo);
      return;
    }
    case 'stash': {
      if (rest[1] && literal(rest[1]) && rest[1].text === 'list') {
        const p = parseGnu(spec('stash list', '--oneline'), [rest[0]!, ...rest.slice(2)], acc, ctx);
        positional(p.pos, p.ddAt, 'none', acc, 'git stash');
        return;
      }
      writeSub(sub, rest, acc, ctx, repo);
      return;
    }
    case 'reflog': {
      const first = rest[1];
      if (first && literal(first) && !first.text.startsWith('-') && first.text !== 'show') { acc.add('once', 'list.form', { cmd: 'git reflog', detail: first.text }, true); return; }
      const p = parseGnu(spec('reflog', '-n:n --date:s --oneline', { numeric: true }), first && literal(first) && first.text === 'show' ? [rest[0]!, ...rest.slice(2)] : rest, acc, ctx);
      positional(p.pos, p.ddAt, 'rev', acc, 'git reflog');
      return;
    }
    case 'remote': {
      const a = rest.slice(1);
      if (a.length === 0 || (a.length === 1 && literal(a[0]) && ['-v', '--verbose'].includes(a[0]!.text))) return;
      acc.add('once', 'list.form', { cmd: 'git remote', detail: a.map(w => w.text).join(' ') }, true);
      return;
    }
    case 'config': {
      const a = rest.slice(1);
      const reading = a.some(w => literal(w) && /^(?:--get|--get-all|--get-regexp|--list|-l|--show-origin|--show-scope|--name-only)$/u.test(w.text));
      const flags = a.filter(isFlagLike);
      if (!a.every(w => literal(w)) || !flags.every(w => /^(?:--get|--get-all|--get-regexp|--list|-l|--show-origin|--show-scope|--name-only|--local|--global|--system)$/u.test(w.text))) {
        acc.add('once', 'list.git_write', { cmd: 'config' }, true);
        return;
      }
      if (!reading && a.filter(w => !isFlagLike(w)).length !== 1) acc.add('once', 'list.git_write', { cmd: 'config' }, true);
      return;
    }
    case 'push': { push(rest, acc, ctx, repo); return; }
    default:
  }
  if (WRITE[sub] !== undefined) { writeSub(sub, rest, acc, ctx, repo); return; }
  if (NET.has(sub) && (sub !== 'worktree' || (rest[1] && literal(rest[1]) && rest[1].text !== 'list'))) { acc.add('once', 'list.git_net', { cmd: sub }, true); return; }
  if (sub === 'worktree') {
    const p = parseGnu(spec('worktree list', '--porcelain'), [rest[0]!, ...rest.slice(2)], acc, ctx);
    positional(p.pos, p.ddAt, 'none', acc, 'git worktree');
    return;
  }
  acc.add('once', 'list.form', { cmd: 'git', detail: sub }, true);
}

function hooksCheck(sub: string, acc: Acc, repo: ReturnType<MatchCtx['repo']>): boolean {
  if (repo.hooksPath || repo.hooksFiles) { acc.add('once', 'list.git_hooks', {}, false); return false; }
  void sub;
  return true;
}

function writeSub(sub: string, rest: Word[], acc: Acc, ctx: MatchCtx, repo: ReturnType<MatchCtx['repo']>): void {
  const mode = WRITE[sub] ?? 'none';
  const p = parseGnu(spec(sub, WRITE_FLAGS, { numeric: true }), rest, acc, ctx);
  positional(p.pos, 0, mode, acc, `git ${sub}`);
  if (!hooksCheck(sub, acc, repo)) return;
  acc.add('ask', 'list.git_write', { cmd: sub }, false);
}

const PUSH_FLAGS = '-u --set-upstream --force-with-lease -f --force --tags --all -n --dry-run -v --verbose -q --quiet --delete --follow-tags --no-verify';
const REMOTE_NAME = /^[A-Za-z0-9_.-]+$/u;
function push(rest: Word[], acc: Acc, ctx: MatchCtx, repo: ReturnType<MatchCtx['repo']>): void {
  const p = parseGnu(spec('push', PUSH_FLAGS), rest, acc, ctx);
  const [remote, ...refs] = p.pos;
  if (remote && (remote.dynamic || !REMOTE_NAME.test(remote.text))) acc.add('once', 'list.form', { cmd: 'git push', detail: remote.text }, true);
  // 設定に無い名前は、git がフォルダとして扱い、そのフォルダのフックを動かす（リポジトリが見つからないときは、git が先に失敗する）
  else if (remote && repo.found && !repo.remotes.includes(remote.text)) acc.add('once', 'list.git_remote', { remote: remote.text }, false);
  for (const r of refs) if (r.dynamic || !/^[A-Za-z0-9_./:+@{}~^-]+$/u.test(r.text)) acc.add('once', 'list.form', { cmd: 'git push', detail: r.text }, true);
  if (!hooksCheck('push', acc, repo)) return;
  acc.add('ask', 'list.git_push', {}, false);
}
