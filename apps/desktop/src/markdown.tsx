/**
 * Safe, incremental-friendly Markdown rendering (UX-09, ART-02).
 *
 * A deliberately small block/inline parser producing React elements, never
 * HTML strings: raw HTML in the source is shown as text, links are limited to
 * http(s)/mailto and open through the explicit external-URL command, and
 * images are not fetched (they render as labelled chips). Unsupported syntax
 * degrades to plain paragraphs rather than guessing.
 */
import { Fragment, type ReactNode } from "react";

export type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "code"; language: string; code: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "quote"; text: string }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "rule" };

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  const flushParagraph = (buffer: string[]) => {
    if (buffer.length > 0) blocks.push({ type: "paragraph", text: buffer.join("\n") });
    buffer.length = 0;
  };
  const paragraph: string[] = [];
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph(paragraph);
      const marker = fence[1] ?? "```";
      const language = fence[2] ?? "";
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trim().startsWith(marker.slice(0, 3))) {
        code.push(lines[i] ?? "");
        i += 1;
      }
      i += 1;
      blocks.push({ type: "code", language, code: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushParagraph(paragraph);
      blocks.push({ type: "heading", level: (heading[1] ?? "#").length, text: heading[2] ?? "" });
      i += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushParagraph(paragraph);
      blocks.push({ type: "rule" });
      i += 1;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1] ?? "")) {
      flushParagraph(paragraph);
      const split = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const header = split(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i] ?? "")) {
        rows.push(split(lines[i] ?? ""));
        i += 1;
      }
      blocks.push({ type: "table", header, rows });
      continue;
    }
    const listMatch = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (listMatch) {
      flushParagraph(paragraph);
      const ordered = listMatch[2] !== undefined;
      const items: string[] = [];
      while (i < lines.length) {
        const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(lines[i] ?? "");
        if (!item || (item[2] !== undefined) !== ordered) break;
        items.push(item[3] ?? "");
        i += 1;
        while (i < lines.length && /^\s{2,}\S/.test(lines[i] ?? "") && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i] ?? "")) {
          items[items.length - 1] = `${items[items.length - 1]} ${(lines[i] ?? "").trim()}`;
          i += 1;
        }
      }
      blocks.push({ type: "list", ordered, items });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushParagraph(paragraph);
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? "")) {
        quote.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "quote", text: quote.join("\n") });
      continue;
    }
    if (line.trim() === "") {
      flushParagraph(paragraph);
      i += 1;
      continue;
    }
    paragraph.push(line);
    i += 1;
  }
  flushParagraph(paragraph);
  return blocks;
}

function safeHref(url: string): string | null {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) return trimmed;
  return null;
}

export type LinkHandler = (url: string) => void;

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~]+~~)|(!\[[^\]]*\]\([^)]*\))|(\[[^\]]+\]\([^)]*\))|(<https?:\/\/[^>\s]+>)/;

export type ImageRenderer = (src: string, alt: string) => ReactNode | null;

export function renderInline(text: string, onLink?: LinkHandler, onImage?: ImageRenderer): ReactNode[] {
  const out: ReactNode[] = [];
  let rest = text;
  let key = 0;
  while (rest.length > 0) {
    const match = INLINE.exec(rest);
    if (!match || match.index === undefined) {
      out.push(rest);
      break;
    }
    if (match.index > 0) out.push(rest.slice(0, match.index));
    const token = match[0];
    key += 1;
    if (match[1]) out.push(<code key={key}>{token.slice(1, -1)}</code>);
    else if (match[2] || match[3]) out.push(<strong key={key}>{renderInline(token.slice(2, -2), onLink)}</strong>);
    else if (match[4] || match[5]) out.push(<em key={key}>{renderInline(token.slice(1, -1), onLink)}</em>);
    else if (match[6]) out.push(<del key={key}>{renderInline(token.slice(2, -2), onLink)}</del>);
    else if (match[7]) {
      const parts = /!\[([^\]]*)\]\(([^)]*)\)/.exec(token);
      const alt = parts?.[1] ?? "image";
      const src = (parts?.[2] ?? "").trim();
      const custom = onImage?.(src, alt);
      out.push(
        custom ? (
          <span key={key}>{custom}</span>
        ) : (
          <span className="chip small" key={key} title="remote images in messages are not fetched">
            image: {alt}
          </span>
        ),
      );
    } else if (match[8]) {
      const parts = /\[([^\]]+)\]\(([^)]*)\)/.exec(token);
      const label = parts?.[1] ?? token;
      const href = safeHref(parts?.[2] ?? "");
      out.push(
        href ? (
          <button className="link inline-link" key={key} onClick={() => onLink?.(href)} title={href} type="button">
            {renderInline(label, onLink)}
          </button>
        ) : (
          <span key={key}>{label}</span>
        ),
      );
    } else if (match[9]) {
      const href = token.slice(1, -1);
      out.push(
        <button className="link inline-link" key={key} onClick={() => onLink?.(href)} title={href} type="button">
          {href}
        </button>,
      );
    }
    rest = rest.slice(match.index + token.length);
  }
  return out;
}

export function Markdown({
  source,
  onLink,
  onCopyCode,
  onImage,
}: {
  source: string;
  onLink?: LinkHandler;
  onCopyCode?: (code: string) => void;
  onImage?: ImageRenderer;
}) {
  const blocks = parseBlocks(source);
  const inline = (text: string) => renderInline(text, onLink, onImage);
  return (
    <div className="markdown">
      {blocks.map((block, index) => {
        switch (block.type) {
          case "heading": {
            const level = Math.min(6, Math.max(1, block.level));
            const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
            return <Tag key={index}>{inline(block.text)}</Tag>;
          }
          case "paragraph":
            return (
              <p key={index}>
                {block.text.split("\n").map((line, li, all) => (
                  <Fragment key={li}>
                    {inline(line)}
                    {li < all.length - 1 && <br />}
                  </Fragment>
                ))}
              </p>
            );
          case "code":
            return (
              <div className="codeblock" key={index}>
                <div className="codeblock-bar">
                  <span className="small muted">{block.language || "code"}</span>
                  {onCopyCode && (
                    <button className="link small" onClick={() => onCopyCode(block.code)} type="button">
                      copy
                    </button>
                  )}
                </div>
                <pre className="text">{block.code}</pre>
              </div>
            );
          case "list":
            return block.ordered ? (
              <ol key={index}>
                {block.items.map((item, ii) => (
                  <li key={ii}>{inline(item)}</li>
                ))}
              </ol>
            ) : (
              <ul key={index}>
                {block.items.map((item, ii) => (
                  <li key={ii}>{inline(item)}</li>
                ))}
              </ul>
            );
          case "quote":
            return <blockquote key={index}>{inline(block.text)}</blockquote>;
          case "table":
            return (
              <div className="table-scroll" key={index}>
                <table>
                  <thead>
                    <tr>
                      {block.header.map((cell, ci) => (
                        <th key={ci}>{inline(cell)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, ri) => (
                      <tr key={ri}>
                        {row.map((cell, ci) => (
                          <td key={ci}>{inline(cell)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "rule":
            return <hr key={index} />;
          default:
            return null;
        }
      })}
    </div>
  );
}
