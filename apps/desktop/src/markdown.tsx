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
import { t } from "./i18n";
import { IconExternal, IconSpark } from "./components/icons";

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

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*\n]+\*)|(_[^_\n]+_)|(~~[^~]+~~)|(!\[[^\]]*\]\([^)]*\))|(\[[^\]]+\]\([^)]*\))|(<https?:\/\/[^>\s]+>)|(https?:\/\/[^\s<>"'`]+)/;

/** A Claude artifact's page, which reads better as a named link than as its address. */
const ARTIFACT = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/([\w-]+)/i;

/**
 * Where a bare address ends: sentence punctuation after it is the prose's,
 * and so is a closing bracket the address did not open.
 */
function bareUrl(token: string): string {
  let url = token;
  for (;;) {
    const last = url.at(-1) ?? "";
    if (/[.,;:!?'"]/.test(last)) url = url.slice(0, -1);
    else if (last === ")" && (url.match(/\(/g) ?? []).length < (url.match(/\)/g) ?? []).length) url = url.slice(0, -1);
    else if (last === "]" && (url.match(/\[/g) ?? []).length < (url.match(/]/g) ?? []).length) url = url.slice(0, -1);
    else return url;
  }
}

/** A link opens in the default browser; an artifact's is a named pill. */
function linkTo(href: string, label: ReactNode | null, key: number, onLink?: LinkHandler): ReactNode {
  const artifact = ARTIFACT.exec(href);
  if (artifact) {
    return (
      <button className="artifact-link" key={key} onClick={() => onLink?.(href)} title={t("Open {url} in your browser", { url: href })} type="button">
        <IconSpark size={12} />
        <span className="artifact-link-label">{label ?? t("Artifact")}</span>
        {label === null && <span className="artifact-link-id mono">{(artifact[1] ?? "").slice(0, 8)}</span>}
        <IconExternal size={11} />
      </button>
    );
  }
  return (
    <button className="link inline-link" key={key} onClick={() => onLink?.(href)} title={t("Open {url} in your browser", { url: href })} type="button">
      {label ?? href}
    </button>
  );
}

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
      const alt = parts?.[1] ?? t("image");
      const src = (parts?.[2] ?? "").trim();
      const custom = onImage?.(src, alt);
      out.push(
        custom ? (
          <span key={key}>{custom}</span>
        ) : (
          <span className="chip small" key={key} title={t("remote images in messages are not fetched")}>
            {t("image: {alt}", { alt })}
          </span>
        ),
      );
    } else if (match[8]) {
      const parts = /\[([^\]]+)\]\(([^)]*)\)/.exec(token);
      const label = parts?.[1] ?? token;
      const href = safeHref(parts?.[2] ?? "");
      // A label that is the address itself says nothing more than the pill would.
      out.push(href ? linkTo(href, label.trim() === href ? null : renderInline(label, onLink), key, onLink) : <span key={key}>{label}</span>);
    } else if (match[9]) {
      out.push(linkTo(token.slice(1, -1), null, key, onLink));
    } else if (match[10]) {
      const href = bareUrl(token);
      out.push(linkTo(href, null, key, onLink));
      rest = rest.slice(match.index + href.length);
      continue;
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
                  <span className="small muted">{block.language || t("code")}</span>
                  {onCopyCode && (
                    <button className="link small" onClick={() => onCopyCode(block.code)} type="button">
                      {t("copy")}
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
