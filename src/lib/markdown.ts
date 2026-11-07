/**
 * A tiny, safe Markdown subset for task descriptions (0034): headings (#, ##, ###), **bold**,
 * `code`, bullet lists (- or *), numbered lists (1.), checkboxes (- [ ] / - [x]) and paragraphs.
 * It parses to plain data (never HTML), so the renderer can only ever output text nodes: nothing
 * typed in a description can inject markup. Pure: shared by the task page and tests.
 */

export type Inline = { kind: "text" | "bold" | "code"; text: string };

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; content: Inline[] }
  | { kind: "paragraph"; content: Inline[] }
  | { kind: "bullets"; items: { content: Inline[] }[] }
  | { kind: "numbers"; start: number; items: { content: Inline[] }[] }
  | { kind: "checks"; items: { content: Inline[]; checked: boolean; line: number }[] };

/** `**bold**` and `` `code` `` inside a line; everything else is text. */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    out.push(m[1] !== undefined ? { kind: "bold", text: m[1] } : { kind: "code", text: m[2]! });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

const CHECK = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBER = /^\s*(\d{1,4})[.)]\s+(.*)$/;
const HEADING = /^(#{1,3})\s+(.*)$/;

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ kind: "paragraph", content: parseInline(para.join(" ")) });
    para = [];
  };
  lines.forEach((line, i) => {
    const last = blocks[blocks.length - 1];
    let m: RegExpExecArray | null;
    if (!line.trim()) {
      flush();
      return;
    }
    if ((m = HEADING.exec(line))) {
      flush();
      blocks.push({ kind: "heading", level: m[1]!.length as 1 | 2 | 3, content: parseInline(m[2]!.trim()) });
    } else if ((m = CHECK.exec(line))) {
      flush();
      const item = { content: parseInline(m[2]!), checked: m[1] !== " ", line: i };
      if (last?.kind === "checks") last.items.push(item);
      else blocks.push({ kind: "checks", items: [item] });
    } else if ((m = BULLET.exec(line))) {
      flush();
      if (last?.kind === "bullets") last.items.push({ content: parseInline(m[1]!) });
      else blocks.push({ kind: "bullets", items: [{ content: parseInline(m[1]!) }] });
    } else if ((m = NUMBER.exec(line))) {
      flush();
      if (last?.kind === "numbers") last.items.push({ content: parseInline(m[2]!) });
      else blocks.push({ kind: "numbers", start: Number(m[1]), items: [{ content: parseInline(m[2]!) }] });
    } else para.push(line.trim());
  });
  flush();
  return blocks;
}

/** Ticks / unticks the checkbox on source line `line` (the rest of the text is unchanged). */
export function toggleCheckbox(src: string, line: number): string {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const l = lines[line];
  if (l === undefined || !CHECK.test(l)) return src;
  lines[line] = l.replace(/\[( |x|X)\]/, (box) => (box === "[ ]" ? "[x]" : "[ ]"));
  return lines.join("\n");
}

/** Checkbox progress of a description ("2 of 5"), or null without checkboxes. */
export function checkboxProgress(src: string): { done: number; total: number } | null {
  let done = 0;
  let total = 0;
  for (const b of parseMarkdown(src)) {
    if (b.kind !== "checks") continue;
    total += b.items.length;
    done += b.items.filter((i) => i.checked).length;
  }
  return total ? { done, total } : null;
}
