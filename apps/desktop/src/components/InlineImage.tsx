/**
 * A workspace image referenced from the transcript (agent Markdown, tool
 * output). Bytes are read natively, sniffed and dimension-checked before they
 * reach the page; the path shown is the workspace-relative one. Missing or
 * non-image paths render nothing rather than a broken image.
 */
import { useEffect, useState } from "react";
import type { WorkspaceImage } from "@thingmaker/contracts";
import { api } from "../ipc";
import { useStore } from "../store";

const cache = new Map<string, Promise<WorkspaceImage | null>>();

export function loadWorkspaceImage(workspaceId: string, relative: string, generated?: string): Promise<WorkspaceImage | null> {
  const key = generated ? `generated|${generated}` : `${workspaceId}|${relative}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = (generated ? api.generatedImage(generated) : api.workspaceImage(workspaceId, relative)).catch(() => null);
    cache.set(key, pending);
    // Images may be regenerated at the same path; forget the entry soon.
    setTimeout(() => cache.delete(key), 15_000);
  }
  return pending;
}

/** Markdown image hook: workspace-relative paths render inline, remote and absolute ones are left out. */
export function workspaceImageRenderer(workspaceId: string) {
  return (src: string, alt: string) => {
    if (!src || /^[a-z]+:\/\//i.test(src) || src.startsWith("/") || src.startsWith("data:")) return null;
    return <InlineImage alt={alt} relative={src.replace(/^\.\//, "")} workspaceId={workspaceId} />;
  };
}

/**
 * Builds a usable `src` from an ACP image block's `data`, which arrives either
 * as bare base64 or as a complete data URL depending on what produced it.
 * Prefixing a value that is already a data URL is what turned attached images
 * into broken-image icons in the transcript.
 */
export function imageSource(data: string, mimeType: string | null | undefined): string {
  const trimmed = data.trim();
  if (/^data:/i.test(trimmed)) return trimmed;
  // Base64 may arrive wrapped; whitespace is not valid inside a data URL.
  return `data:${mimeType ?? "image/png"};base64,${trimmed.replace(/\s+/g, "")}`;
}

/** An image content block, with a labelled fallback instead of a broken icon. */
export function BlockImage({ data, mimeType, uri, workspaceId }: { data: string | null | undefined; mimeType: string | null | undefined; uri: string | null | undefined; workspaceId: string }) {
  const [broken, setBroken] = useState(false);
  const openUrl = useStore((s) => s.openUrl);

  // A workspace-relative uri is a file we can read ourselves.
  if (!data && uri && !/^[a-z]+:\/\//i.test(uri) && !uri.startsWith("/")) {
    return <InlineImage relative={uri.replace(/^\.\//, "")} workspaceId={workspaceId} />;
  }
  if (!data || broken) {
    return (
      <span className="chip small" title={broken ? "the image data in this message could not be decoded" : undefined}>
        {broken ? "image could not be displayed" : `image ${uri ?? "(inline)"}`}
        {uri && /^file:\/\//i.test(uri) && (
          <button className="link small" onClick={() => void openUrl(uri)} type="button">
            open
          </button>
        )}
      </span>
    );
  }
  return <img alt="attached image" className="image" onError={() => setBroken(true)} src={imageSource(data, mimeType)} />;
}

/**
 * Thumbnail of an attachment that has not been sent yet, read from the stored
 * blob. Non-image or oversized attachments simply render nothing, leaving the
 * chip's name and size to describe them.
 */
export function AttachmentThumb({ id, name }: { id: string; name: string }) {
  const [preview, setPreview] = useState<{ mime: string; dataBase64: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .attachmentPreview(id)
      .then((result) => {
        if (!cancelled) setPreview({ mime: result.mime, dataBase64: result.dataBase64 });
      })
      .catch(() => {
        if (!cancelled) setPreview(null);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!preview) return null;
  return <img alt={name} className="attachment-thumb" src={imageSource(preview.dataBase64, preview.mime)} />;
}

/**
 * `generated` is an absolute path under Codex's `generated_images`, read
 * through its own command; otherwise `relative` is inside the workspace.
 */
export function InlineImage({ workspaceId, relative, alt, generated }: { workspaceId: string; relative: string; alt?: string; generated?: string }) {
  const openUrl = useStore((s) => s.openUrl);
  const [image, setImage] = useState<WorkspaceImage | null | undefined>(undefined);
  const [large, setLarge] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadWorkspaceImage(workspaceId, relative, generated).then((result) => {
      if (!cancelled) setImage(result);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, relative, generated]);

  // Escape closes the opened image, the way every other overlay behaves. The
  // listener is only attached while it is open, so it cannot swallow Escape
  // from the composer or a menu.
  useEffect(() => {
    if (!large) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setLarge(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [large]);

  if (image === undefined) return <span className="chip small muted">loading {relative}…</span>;
  if (image === null) return null;
  const src = `data:${image.mime};base64,${image.dataBase64}`;
  return (
    <>
      <figure className="inline-image">
        <button className="inline-image-button" onClick={() => setLarge(true)} title="Open larger" type="button">
          <img alt={alt ?? relative} src={src} />
        </button>
        <figcaption className="small muted">
          <span className="mono">{relative}</span> · {image.width}×{image.height} · {(image.bytes / 1024).toFixed(0)} KiB
          {image.credentials?.generator ? (
            <span title="Generator recorded in the file's Content Credentials (C2PA manifest), read as recorded and not signature-verified">
              {" "}· {image.credentials.generator}
              {image.credentials.generatorVersion ? ` ${image.credentials.generatorVersion}` : ""}
            </span>
          ) : null}
        </figcaption>
      </figure>
      {large && (
        <div aria-modal="true" className="modal-backdrop" onClick={() => setLarge(false)} role="dialog">
          <div className="image-lightbox" onClick={(e) => e.stopPropagation()}>
            <img alt={alt ?? relative} src={src} />
            <div className="row wrap">
              <span className="mono small">{relative}</span>
              <span className="small muted">
                {image.width}×{image.height} · {image.mime}
                {image.credentials?.generator ? ` · Content Credentials: ${image.credentials.generator}${image.credentials.generatorVersion ? ` ${image.credentials.generatorVersion}` : ""}${image.credentials.claimGenerator ? ` (${image.credentials.claimGenerator})` : ""}` : ""}
              </span>
              <button className="button button-small" onClick={() => void openUrl(`file://${image.absolutePath}`)} type="button">
                Open externally
              </button>
              <button className="button button-small" onClick={() => setLarge(false)} type="button">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const IMAGE_PATH = /(?:^|[\s"'`(\[])((?:[\w.@-]+\/)*[\w.@-]+\.(?:png|jpe?g|webp|gif))(?=$|[\s"'`)\],;:])/gi;

/** Workspace-relative image paths mentioned in a piece of text. */
export function imagePathsIn(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(IMAGE_PATH)) {
    const path = match[1];
    if (!path || path.startsWith("http://") || path.startsWith("https://") || path.startsWith("/")) continue;
    out.add(path.replace(/^\.\//, ""));
  }
  return [...out];
}
