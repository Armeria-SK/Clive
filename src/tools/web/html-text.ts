import { parse, type DefaultTreeAdapterTypes as Tree } from 'parse5';

const OMITTED = new Set(['script', 'style', 'template', 'noscript', 'svg', 'math', 'iframe', 'object', 'canvas', 'nav', 'footer', 'aside']);
const BLOCKS = new Set(['address', 'article', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul']);
const VERBATIM = new Set(['pre', 'textarea', 'listing', 'xmp']);

export const attribute = (node: Tree.Element, name: string) => node.attrs.find(attr => attr.name === name)?.value;

function hidden(node: Tree.Element): boolean {
  return OMITTED.has(node.tagName)
    || node.attrs.some(attr => attr.name === 'hidden' || attr.name === 'inert')
    || attribute(node, 'aria-hidden')?.trim().toLowerCase() === 'true'
    || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/iu.test(attribute(node, 'style') ?? '');
}

export interface HtmlText { title: string; text: string; links: Array<{ url: string; text: string }> }

export function htmlText(html: string, url: string): HtmlText {
  const document = parse(html);
  const nodes: Tree.Node[] = [document];
  let body: Tree.Element | undefined;
  let main: Tree.Element | undefined;
  let title = '';
  while (nodes.length) {
    const node = nodes.pop()!;
    if ('tagName' in node) {
      if (hidden(node)) continue;
      if (node.tagName === 'body') body = node;
      if (node.tagName === 'main' && !main) main = node;
      if (node.tagName === 'title') title = node.childNodes.filter((child): child is Tree.TextNode => 'value' in child).map(child => child.value).join('').trim().slice(0, 300);
    }
    if ('childNodes' in node) for (let i = node.childNodes.length - 1; i >= 0; i--) nodes.push(node.childNodes[i]!);
  }
  const root = main ?? body;
  const parts: string[] = [];
  const links: HtmlText['links'] = [];
  const seen = new Set<string>();
  const literal: string[] = [];
  let pre = 0;
  // 整形済みの文字は空白を保つため、私用領域の印で退避しておき、最後の空白の整理で崩れないようにする
  const restore = (text: string, flat: boolean) => text.replace(/(\d+)/gu, (_, i: string) => (flat ? literal[+i]!.replace(/\s+/gu, ' ') : literal[+i]!));
  const stack: Array<{ node: Tree.Node; end?: boolean; link?: string; start?: number }> = root ? [{ node: root }] : [];
  while (stack.length) {
    const frame = stack.pop()!;
    const node = frame.node;
    if (frame.end) {
      if (frame.link && !seen.has(frame.link) && links.length < 30) {
        links.push({ url: frame.link, text: restore(parts.slice(frame.start).join(''), true).replace(/\s+/gu, ' ').trim().slice(0, 200) });
        seen.add(frame.link);
      }
      if ('tagName' in node) {
        if (VERBATIM.has(node.tagName)) {
          pre--;
          const last = /^(\d+)$/u.exec(parts.at(-1) ?? '');
          if (last) literal[+last[1]!] = literal[+last[1]!]!.replace(/\n$/u, '');
        }
        if (BLOCKS.has(node.tagName)) parts.push('\n');
      }
      continue;
    }
    if ('value' in node) {
      const value = node.value.replace(/[]/gu, '');
      if (pre) { literal.push(value.replace(/\r\n?/gu, '\n')); parts.push(`${literal.length - 1}`); }
      else parts.push(value.replace(/\s+/gu, ' '));
      continue;
    }
    if (!('tagName' in node) || hidden(node)) continue;
    if (BLOCKS.has(node.tagName)) parts.push('\n');
    if (VERBATIM.has(node.tagName)) pre++;
    if (node.tagName === 'td' || node.tagName === 'th') parts.push(' | ');
    let link: string | undefined;
    const href = node.tagName === 'a' ? attribute(node, 'href') : undefined;
    if (href && links.length < 30) {
      try {
        const target = new URL(href, url);
        if (['http:', 'https:'].includes(target.protocol) && !target.username && !target.password && target.href.length <= 4096) link = target.href;
      } catch { }
    }
    stack.push({ node, end: true, ...(link ? { link, start: parts.length } : {}) });
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push({ node: node.childNodes[i]! });
  }
  return { title, text: restore(parts.join('').replace(/ *\n */gu, '\n').replace(/\n{3,}/gu, '\n\n').trim(), false), links };
}
