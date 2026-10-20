import { useMemo } from "react";
import type { ToolPatch } from "@thingmaker/contracts";
import { t } from "../i18n";
import { toolImages } from "../toolImages";
import { BlockImage, imageSource } from "./InlineImage";

/** Shared desktop/Android tool detail: encoded image blocks become pictures. */
export function ToolPayloads({ patch, workspaceId }: { patch: ToolPatch; workspaceId: string }) {
  const sections = useMemo(() => {
    const seen = new Set<string>();
    return [[t("Input"), patch.rawInput], [t("Output"), patch.rawOutput], [t("Content"), patch.content]]
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([label, value]) => {
        const { detail, images } = toolImages(value);
        return { label: label as string, detail, images: images.filter((image) => {
          const key = image.data ? imageSource(image.data, image.mimeType) : image.uri;
          if (!key) return true;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }) };
      });
  }, [patch.rawInput, patch.rawOutput, patch.content]);
  return <>{sections.map(({ label, detail, images }) => (
    <section className="tool-payload" key={label}>
      <h4>{label}</h4>
      <pre className="text">{JSON.stringify(detail, null, 2)}</pre>
      <div className="tool-images">{images.map((image, index) => (
        <BlockImage data={image.data} key={index} mimeType={image.mimeType} uri={image.uri} workspaceId={workspaceId} />
      ))}</div>
    </section>
  ))}</>;
}
