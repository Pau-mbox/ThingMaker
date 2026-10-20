import { t } from "./i18n";

export type ToolImage = { data?: string; mimeType?: string; uri?: string };

/** Separate image bytes from diagnostic text, including nested ACP/MCP results. */
export function toolImages(value: unknown): { detail: unknown; images: ToolImage[] } {
  const images: ToolImage[] = [];
  const walk = (node: unknown): unknown => {
    if (typeof node === "string" && /^[\s]*[\[{]/.test(node)) {
      // Some providers put the entire MCP result inside a text block.
      try {
        const before = images.length;
        const detail = walk(JSON.parse(node));
        if (images.length > before) return detail;
      } catch { /* Ordinary tool text remains verbatim. */ }
      return node;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const record = node as Record<string, unknown>;
    const source = record.source && typeof record.source === "object" ? record.source as Record<string, unknown> : undefined;
    const resource = record.resource && typeof record.resource === "object" ? record.resource as Record<string, unknown> : undefined;
    const mime = record.mimeType ?? record.mime_type ?? source?.media_type ?? resource?.mimeType;
    const data = record.data ?? source?.data ?? resource?.blob;
    const uri = record.uri ?? resource?.uri;
    const url = typeof record.image_url === "string" ? record.image_url : (record.image_url as { url?: unknown } | undefined)?.url;
    if (record.type === "image" || record.type === "image_url" || (record.type === "resource" && typeof mime === "string" && mime.startsWith("image/"))) {
      images.push({
        ...(typeof data === "string" ? { data } : typeof url === "string" && /^data:image\//i.test(url) ? { data: url } : {}),
        ...(typeof mime === "string" ? { mimeType: mime } : {}),
        ...(typeof uri === "string" ? { uri } : {}),
      });
      return t("[image shown below]");
    }
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, walk(child)]));
  };
  return { detail: walk(value), images };
}
