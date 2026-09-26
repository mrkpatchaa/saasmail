import type { jmapMessageContent } from "../db/jmap-message-content.schema";
import { htmlToText } from "../lib/html-to-text";

export type ContentAddress = { name: string | null; email: string };

export type ContentLeaf = {
  /** "1", "2", … in depth-first order. */
  partId: string;
  /** Lowercased media type. */
  type: string;
  /** "utf-8" for text leaves, null otherwise. */
  charset: string | null;
  name: string | null;
  disposition: "attachment" | "inline" | null;
  /** Without angle brackets. */
  cid: string | null;
  /** Decoded octets. */
  size: number;
  /** Content-owned R2 copy; null for text leaves (value in body_values_json). */
  r2Key: string | null;
};

export type ContentMultipart = {
  partId: null;
  type: "multipart/mixed" | "multipart/alternative" | "multipart/related";
  subParts: ContentPart[];
};

export type ContentPart = ContentLeaf | ContentMultipart;

export type JmapContentRow = typeof jmapMessageContent.$inferSelect;

export type BodyLists = {
  textBody: string[];
  htmlBody: string[];
  attachments: string[];
};

export function isMultipart(part: ContentPart): part is ContentMultipart {
  return part.partId === null;
}

/** Leaves in depth-first order (the order part ids were assigned in). */
export function contentLeaves(part: ContentPart): ContentLeaf[] {
  if (isMultipart(part)) return part.subParts.flatMap(contentLeaves);
  return [part as ContentLeaf];
}

export function toCrlf(value: string): string {
  return value.replace(/\r?\n/g, "\r\n");
}

export function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function isInlineMediaType(type: string): boolean {
  return (
    type.startsWith("image/") ||
    type.startsWith("audio/") ||
    type.startsWith("video/")
  );
}

/**
 * RFC 8621 §4.1.4 `parseStructure`, transcribed. `textBody`/`htmlBody` become
 * null inside multipart/alternative once the other flavour is chosen, exactly
 * as in the RFC's pseudocode.
 */
function parseStructure(
  parts: ContentPart[],
  multipartType: string,
  inAlternative: boolean,
  htmlBody: ContentLeaf[] | null,
  textBody: ContentLeaf[] | null,
  attachments: ContentLeaf[],
): void {
  const textLength = textBody ? textBody.length : -1;
  const htmlLength = htmlBody ? htmlBody.length : -1;

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (isMultipart(part)) {
      const subMultiType = part.type.split("/")[1];
      parseStructure(
        part.subParts,
        subMultiType,
        inAlternative || subMultiType === "alternative",
        htmlBody,
        textBody,
        attachments,
      );
      continue;
    }
    const leaf = part as ContentLeaf;
    const isInline =
      leaf.disposition !== "attachment" &&
      (leaf.type === "text/plain" ||
        leaf.type === "text/html" ||
        isInlineMediaType(leaf.type)) &&
      (i === 0 ||
        (multipartType !== "related" &&
          (isInlineMediaType(leaf.type) || !leaf.name)));

    if (!isInline) {
      attachments.push(leaf);
      continue;
    }
    if (multipartType === "alternative") {
      if (leaf.type === "text/plain") {
        if (textBody) textBody.push(leaf);
      } else if (leaf.type === "text/html") {
        if (htmlBody) htmlBody.push(leaf);
      } else {
        attachments.push(leaf);
      }
      continue;
    }
    if (inAlternative) {
      if (leaf.type === "text/plain") htmlBody = null;
      if (leaf.type === "text/html") textBody = null;
    }
    if (textBody) textBody.push(leaf);
    if (htmlBody) htmlBody.push(leaf);
    if ((!textBody || !htmlBody) && isInlineMediaType(leaf.type)) {
      attachments.push(leaf);
    }
  }

  if (multipartType === "alternative" && textBody && htmlBody) {
    // Found HTML part only
    if (textLength === textBody.length && htmlLength !== htmlBody.length) {
      for (let i = htmlLength; i < htmlBody.length; i += 1) {
        textBody.push(htmlBody[i]);
      }
    }
    // Found plaintext part only
    if (htmlLength === htmlBody.length && textLength !== textBody.length) {
      for (let i = textLength; i < textBody.length; i += 1) {
        htmlBody.push(textBody[i]);
      }
    }
  }
}

export function deriveBodyLists(root: ContentPart): BodyLists {
  const textBody: ContentLeaf[] = [];
  const htmlBody: ContentLeaf[] = [];
  const attachments: ContentLeaf[] = [];
  parseStructure([root], "mixed", false, htmlBody, textBody, attachments);
  const ids = (parts: ContentLeaf[]) => parts.map((part) => part.partId);
  return {
    textBody: ids(textBody),
    htmlBody: ids(htmlBody),
    attachments: ids(attachments),
  };
}

/** RFC 8621 `preview`: up to 256 characters of plain text. */
export function contentPreview(
  root: ContentPart,
  bodyValues: Record<string, string>,
  lists: BodyLists,
): string {
  const leaves = new Map(
    contentLeaves(root).map((leaf) => [leaf.partId, leaf]),
  );
  const first = (ids: string[], type: string) =>
    ids
      .map((id) => leaves.get(id))
      .find(
        (leaf) =>
          leaf !== undefined &&
          leaf.type === type &&
          bodyValues[leaf.partId] !== undefined,
      );
  const text = first(lists.textBody, "text/plain");
  const html = first(lists.htmlBody, "text/html");
  const source = text
    ? bodyValues[text.partId]
    : html
      ? htmlToText(bodyValues[html.partId])
      : "";
  return source.replace(/\s+/g, " ").trim().slice(0, 256);
}
