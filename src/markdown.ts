import { html, Html } from "./html.ts";

/**
 * Renders the Markdown the answers AI writes for documents. It handles the
 * subset those documents use (headings, nested lists, quotes, emphasis, links,
 * rules) and escapes everything else, so model output can never inject HTML.
 */
export function renderMarkdown(markdown: string, sourceCount = 0, anchorPrefix = "source"): Html {
  const cite: Cite = { count: sourceCount, prefix: anchorPrefix };
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: Html[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) { index += 1; continue; }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/u.exec(line);
    if (heading) {
      // The page's own <h1> is the document title, so any other "#" heading becomes <h2>.
      const level = Math.max(2, heading[1]!.length);
      blocks.push(html`${new Html(`<h${level}>`)}${inline(heading[2]!, cite)}${new Html(`</h${level}>`)}`);
      index += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/u.test(line)) {
      blocks.push(html`<hr>`);
      index += 1;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const items: string[] = [];
      while (index < lines.length && (LIST_ITEM.test(lines[index]!) || (lines[index]!.trim() && /^\s{2,}\S/u.test(lines[index]!) && items.length > 0))) {
        if (LIST_ITEM.test(lines[index]!)) items.push(lines[index]!);
        else items[items.length - 1] += ` ${lines[index]!.trim()}`;
        index += 1;
      }
      blocks.push(list(items, cite));
      continue;
    }
    if (/^\s*>/u.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/u.test(lines[index]!)) quoted.push(lines[index++]!.replace(/^\s*>\s?/u, ""));
      blocks.push(html`<blockquote>${renderMarkdown(quoted.join("\n"), sourceCount, anchorPrefix)}</blockquote>`);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index]!.trim() && !startsBlock(lines[index]!)) paragraph.push(lines[index++]!.trim());
    blocks.push(html`<p>${inline(paragraph.join(" "), cite)}</p>`);
  }
  return html`${blocks.map((block) => html`${block}\n`)}`;
}

/** How citations like [2] link to their sources. */
interface Cite { readonly count: number; readonly prefix: string }

const LIST_ITEM = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/u;

function startsBlock(line: string): boolean {
  return /^#{1,6}\s/u.test(line) || LIST_ITEM.test(line) || /^\s*>/u.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/u.test(line);
}

interface ListNode { readonly ordered: boolean; readonly items: { text: string; children: ListNode[] }[] }

/** Builds nested lists from indentation: deeper items belong to the item above them. */
function list(lines: readonly string[], cite: Cite): Html {
  const root: ListNode = { ordered: /^\s*\d/u.test(lines[0]!), items: [] };
  const stack: { indent: number; node: ListNode }[] = [{ indent: indentOf(lines[0]!), node: root }];
  for (const line of lines) {
    const match = LIST_ITEM.exec(line)!;
    const indent = indentOf(line);
    const ordered = /\d/u.test(match[2]!);
    while (stack.length > 1 && indent < stack.at(-1)!.indent) stack.pop();
    let top = stack.at(-1)!;
    if (indent > top.indent && top.node.items.length > 0) {
      const child: ListNode = { ordered, items: [] };
      top.node.items.at(-1)!.children.push(child);
      stack.push({ indent, node: child });
      top = stack.at(-1)!;
    }
    top.node.items.push({ text: match[3]!, children: [] });
  }
  return renderList(root, cite);
}

function indentOf(line: string): number {
  return line.replace(/\t/gu, "    ").search(/\S/u);
}

function renderList(node: ListNode, cite: Cite): Html {
  const items = node.items.map((item) => html`<li>${inline(item.text, cite)}${item.children.map((child) => renderList(child, cite))}</li>`);
  return node.ordered ? html`<ol>${items}</ol>` : html`<ul>${items}</ul>`;
}

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|`[^`]+`|\[[^\]]+\]\([^)\s]+\)|\[\d+(?:\s*,\s*\d+)*\])/gu;

function inline(text: string, cite: Cite): Html {
  const parts: Html[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    parts.push(html`${text.slice(last, match.index)}`);
    parts.push(token(match[0], cite));
    last = match.index + match[0].length;
  }
  parts.push(html`${text.slice(last)}`);
  return html`${parts}`;
}

function token(value: string, cite: Cite): Html {
  if (value.startsWith("**") || value.startsWith("__")) return html`<strong>${inline(value.slice(2, -2), cite)}</strong>`;
  if (value.startsWith("`")) return html`<code>${value.slice(1, -1)}</code>`;
  if (value.startsWith("*") || value.startsWith("_")) return html`<em>${inline(value.slice(1, -1), cite)}</em>`;
  const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/u.exec(value);
  if (link) {
    // Only web and same-site links; anything else (javascript:, data:) stays as text.
    return /^(https?:\/\/|\/(?!\/)|#)/iu.test(link[2]!) ? html`<a href="${link[2]}">${inline(link[1]!, cite)}</a>` : html`${value}`;
  }
  const numbers = value.slice(1, -1).split(",").map((part) => Number(part.trim()));
  return numbers.every((n) => n >= 1 && n <= cite.count)
    ? html`<sup>${numbers.map((n, index) => html`${index ? ", " : ""}<a href="#${cite.prefix}-${n}">${n}</a>`)}</sup>`
    : html`${value}`;
}
