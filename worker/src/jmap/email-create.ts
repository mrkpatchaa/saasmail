import type { ContentAddress, ContentMultipart } from "./content";

export type SetError = {
  type: string;
  description?: string;
  properties?: string[];
  notFound?: string[];
};

/** A per-object /set failure. A class so `instanceof` narrows with strict off. */
export class Rejection {
  constructor(readonly error: SetError) {}
}

function reject(...properties: string[]): Rejection {
  return new Rejection({ type: "invalidProperties", properties });
}

/** Mirrors the web composer's cap (routers/send-router.ts). */
export const MAX_CC_ENTRIES = 50;
const MAX_TO_ENTRIES = 50;
const MAX_BCC_ENTRIES = 50;
const MAX_REPLY_TO_ENTRIES = 10;
const MAX_ATTACHMENTS = 100;
const MAX_BODY_LEAVES = 100;
const MAX_STRUCTURE_DEPTH = 4;
const MAX_SUBJECT_LENGTH = 900;
const MAX_NAME_LENGTH = 256;
const MAX_MESSAGE_ID_LENGTH = 250;
const MAX_REFERENCES = 100;

export const DRAFT_KEYWORDS: ReadonlySet<string> = new Set([
  "$draft",
  "$seen",
  "$flagged",
]);

type Disposition = "attachment" | "inline" | null;

export type BodyInputText = {
  kind: "text";
  type: "text/plain" | "text/html";
  /** LF line endings (RFC 8621 EmailBodyValue). */
  value: string;
  name: string | null;
  disposition: Disposition;
  cid: string | null;
};

export type BodyInputBlob = {
  kind: "blob";
  blobId: string;
  /** null = take the resolved blob's type. */
  type: string | null;
  name: string | null;
  disposition: Disposition;
  cid: string | null;
};

export type BodyInputMultipart = {
  kind: "multipart";
  type: ContentMultipart["type"];
  subParts: BodyInput[];
};

export type BodyInput = BodyInputText | BodyInputBlob | BodyInputMultipart;

export function isInputMultipart(part: BodyInput): part is BodyInputMultipart {
  return part.kind === "multipart";
}
export function isTextInput(part: BodyInput): part is BodyInputText {
  return part.kind === "text";
}
export function isBlobInput(part: BodyInput): part is BodyInputBlob {
  return part.kind === "blob";
}

export function inputLeaves(
  part: BodyInput,
): (BodyInputText | BodyInputBlob)[] {
  if (isInputMultipart(part)) return part.subParts.flatMap(inputLeaves);
  return [part as BodyInputText | BodyInputBlob];
}

export type ParsedEmailCreate = {
  /** The one mailbox id given (checked against the identity's Drafts later). */
  mailboxId: string;
  seen: boolean;
  flagged: boolean;
  from: ContentAddress;
  to: ContentAddress[];
  cc: ContentAddress[];
  bcc: ContentAddress[];
  replyTo: ContentAddress[] | null;
  subject: string;
  /** null = server generates. */
  messageId: string | null;
  inReplyTo: string[] | null;
  references: string[] | null;
  /** RFC 3339 as given; null = server sets now. */
  sentAt: string | null;
  /** Unix seconds; null = server sets now. */
  receivedAt: number | null;
  body: BodyInput;
};

const CREATE_PROPERTIES = new Set([
  "mailboxIds",
  "keywords",
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "sender",
  "subject",
  "sentAt",
  "receivedAt",
  "messageId",
  "inReplyTo",
  "references",
  "bodyStructure",
  "textBody",
  "htmlBody",
  "attachments",
  "bodyValues",
]);
const SERVER_SET = new Set([
  "id",
  "blobId",
  "threadId",
  "size",
  "hasAttachment",
  "preview",
]);
const PART_KEYS = new Set([
  "partId",
  "blobId",
  "type",
  "charset",
  "name",
  "disposition",
  "cid",
  "size",
  "subParts",
  "language",
  "location",
]);

const HEADER_UNSAFE = /[\r\n]/;
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+$/;
const MESSAGE_ID_PATTERN = /^[^\s<>]+@[^\s<>]+$/;
const CID_PATTERN = /^[^\s<>]+$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
const UTC_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/i;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function absent(value: unknown): boolean {
  return value === undefined || value === null;
}

function parseAddress(value: unknown): ContentAddress | null {
  if (!isObject(value)) return null;
  for (const key of Object.keys(value)) {
    if (key !== "name" && key !== "email") return null;
  }
  const email = value.email;
  const name = value.name;
  if (typeof email !== "string" || !EMAIL_PATTERN.test(email.trim())) {
    return null;
  }
  if (
    !absent(name) &&
    (typeof name !== "string" ||
      HEADER_UNSAFE.test(name) ||
      name.length > MAX_NAME_LENGTH)
  ) {
    return null;
  }
  const trimmed = typeof name === "string" ? name.trim() : "";
  return { name: trimmed.length > 0 ? trimmed : null, email: email.trim() };
}

/** [] when absent; null when invalid. */
function parseAddressList(
  value: unknown,
  max: number,
): ContentAddress[] | null {
  if (absent(value)) return [];
  if (!Array.isArray(value) || value.length > max) return null;
  const result: ContentAddress[] = [];
  for (const item of value) {
    const address = parseAddress(item);
    if (!address) return null;
    result.push(address);
  }
  return result;
}

/** { ids: null } when absent; null when invalid. */
function parseMessageIds(
  value: unknown,
  max: number,
): { ids: string[] | null } | null {
  if (absent(value)) return { ids: null };
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    return null;
  }
  const ids: string[] = [];
  for (const item of value) {
    if (
      typeof item !== "string" ||
      item.length > MAX_MESSAGE_ID_LENGTH ||
      !MESSAGE_ID_PATTERN.test(item)
    ) {
      return null;
    }
    ids.push(item);
  }
  return { ids };
}

function parseBodyValues(value: unknown): Map<string, string> | null {
  const values = new Map<string, string>();
  if (absent(value)) return values;
  if (!isObject(value)) return null;
  for (const [partId, entry] of Object.entries(value)) {
    if (!isObject(entry) || typeof entry.value !== "string") return null;
    for (const key of Object.keys(entry)) {
      if (
        key !== "value" &&
        key !== "isEncodingProblem" &&
        key !== "isTruncated"
      ) {
        return null;
      }
    }
    if (!absent(entry.isEncodingProblem) && entry.isEncodingProblem !== false) {
      return null;
    }
    if (!absent(entry.isTruncated) && entry.isTruncated !== false) return null;
    values.set(partId, entry.value.replace(/\r\n/g, "\n"));
  }
  return values;
}

type LeafCommon = {
  name: string | null;
  disposition: Disposition;
  cid: string | null;
};

function parseLeafCommon(
  value: Record<string, unknown>,
  property: string,
): LeafCommon | Rejection {
  let name: string | null = null;
  if (!absent(value.name)) {
    if (
      typeof value.name !== "string" ||
      HEADER_UNSAFE.test(value.name) ||
      value.name.length > MAX_NAME_LENGTH
    ) {
      return reject(property);
    }
    name = value.name.trim() || null;
  }
  let disposition: Disposition = null;
  if (!absent(value.disposition)) {
    const given =
      typeof value.disposition === "string"
        ? value.disposition.toLowerCase()
        : "";
    if (given !== "inline" && given !== "attachment") return reject(property);
    disposition = given;
  }
  let cid: string | null = null;
  if (!absent(value.cid)) {
    if (typeof value.cid !== "string") return reject(property);
    const bare = value.cid.replace(/^<(.*)>$/, "$1");
    if (!CID_PATTERN.test(bare) || bare.length > MAX_MESSAGE_ID_LENGTH) {
      return reject(property);
    }
    cid = bare;
  }
  if (!absent(value.language) || !absent(value.location)) {
    return reject(property);
  }
  return { name, disposition, cid };
}

function mediaType(value: unknown): string | null | Rejection {
  if (absent(value)) return null;
  if (typeof value !== "string") return reject();
  const type = value.trim().toLowerCase();
  return MEDIA_TYPE.test(type) ? type : reject();
}

/** A text part (partId) or blob part (blobId); never both. */
function parseLeaf(
  value: Record<string, unknown>,
  bodyValues: Map<string, string>,
  property: string,
  onlyText: "text/plain" | "text/html" | null,
): BodyInputText | BodyInputBlob | Rejection {
  const type = mediaType(value.type);
  if (type instanceof Rejection) return reject(property);
  const common = parseLeafCommon(value, property);
  if (common instanceof Rejection) return common;
  const hasPartId = !absent(value.partId);
  const hasBlobId = !absent(value.blobId);
  if (hasPartId === hasBlobId) return reject(property);

  if (hasPartId) {
    const textType = type ?? onlyText ?? "text/plain";
    if (textType !== "text/plain" && textType !== "text/html") {
      return reject(property);
    }
    if (onlyText !== null && textType !== onlyText) return reject(property);
    if (
      !absent(value.charset) &&
      (typeof value.charset !== "string" ||
        value.charset.toLowerCase() !== "utf-8")
    ) {
      return reject(property);
    }
    if (!absent(value.size)) return reject(property);
    if (typeof value.partId !== "string") return reject(property);
    const text = bodyValues.get(value.partId);
    if (text === undefined) return reject(property);
    return { kind: "text", type: textType, value: text, ...common };
  }

  if (onlyText !== null) return reject(property);
  if (typeof value.blobId !== "string") return reject(property);
  return { kind: "blob", blobId: value.blobId, type, ...common };
}

function parseStructurePart(
  value: unknown,
  bodyValues: Map<string, string>,
  depth: number,
): BodyInput | Rejection {
  if (depth > MAX_STRUCTURE_DEPTH || !isObject(value)) {
    return reject("bodyStructure");
  }
  for (const key of Object.keys(value)) {
    if (!PART_KEYS.has(key)) return reject("bodyStructure");
  }
  const type =
    typeof value.type === "string" ? value.type.trim().toLowerCase() : null;
  if (type !== null && type.startsWith("multipart/")) {
    if (
      type !== "multipart/mixed" &&
      type !== "multipart/alternative" &&
      type !== "multipart/related"
    ) {
      return reject("bodyStructure");
    }
    if (!absent(value.partId) || !absent(value.blobId)) {
      return reject("bodyStructure");
    }
    if (!Array.isArray(value.subParts) || value.subParts.length === 0) {
      return reject("bodyStructure");
    }
    const subParts: BodyInput[] = [];
    for (const sub of value.subParts) {
      const parsed = parseStructurePart(sub, bodyValues, depth + 1);
      if (parsed instanceof Rejection) return parsed;
      subParts.push(parsed);
    }
    return { kind: "multipart", type, subParts };
  }
  if (!absent(value.subParts)) return reject("bodyStructure");
  return parseLeaf(value, bodyValues, "bodyStructure", null);
}

function isTextLeaf(part: BodyInput, type: string): boolean {
  return (
    isTextInput(part) && part.type === type && part.disposition !== "attachment"
  );
}

function isRelated(part: BodyInput): boolean {
  return (
    isInputMultipart(part) &&
    part.type === "multipart/related" &&
    part.subParts.length >= 2 &&
    isTextLeaf(part.subParts[0], "text/html") &&
    part.subParts.slice(1).every(isBlobInput)
  );
}

/**
 * Spec §3.1 shapes: text | html | alternative(text, html|related)
 * | related(html, inline blobs…), optionally inside mixed(body, attachments…).
 */
function isBody(part: BodyInput): boolean {
  if (isTextLeaf(part, "text/plain") || isTextLeaf(part, "text/html"))
    return true;
  if (isRelated(part)) return true;
  if (!isInputMultipart(part) || part.type !== "multipart/alternative") {
    return false;
  }
  if (part.subParts.length !== 2) return false;
  const plain = part.subParts.filter((sub) => isTextLeaf(sub, "text/plain"));
  const rich = part.subParts.filter(
    (sub) => isTextLeaf(sub, "text/html") || isRelated(sub),
  );
  return plain.length === 1 && rich.length === 1;
}

function isSupportedShape(root: BodyInput): boolean {
  if (isBody(root)) return true;
  return (
    isInputMultipart(root) &&
    root.type === "multipart/mixed" &&
    root.subParts.length >= 2 &&
    isBody(root.subParts[0]) &&
    root.subParts.slice(1).every(isBlobInput)
  );
}

function parseFlatBody(
  value: unknown,
  type: "text/plain" | "text/html",
  property: string,
  bodyValues: Map<string, string>,
): BodyInputText | null | Rejection {
  if (absent(value)) return null;
  if (!Array.isArray(value)) return reject(property);
  if (value.length === 0) return null;
  if (value.length !== 1 || !isObject(value[0])) return reject(property);
  for (const key of Object.keys(value[0])) {
    if (!PART_KEYS.has(key) || key === "subParts") return reject(property);
  }
  const parsed = parseLeaf(value[0], bodyValues, property, type);
  if (parsed instanceof Rejection) return parsed;
  return parsed as BodyInputText;
}

function parseFlatAttachments(value: unknown): BodyInputBlob[] | Rejection {
  if (absent(value)) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) {
    return reject("attachments");
  }
  const result: BodyInputBlob[] = [];
  for (const item of value) {
    if (!isObject(item)) return reject("attachments");
    for (const key of Object.keys(item)) {
      if (!PART_KEYS.has(key) || key === "subParts")
        return reject("attachments");
    }
    if (!absent(item.partId)) return reject("attachments");
    const parsed = parseLeaf(item, new Map(), "attachments", null);
    if (parsed instanceof Rejection) return parsed;
    result.push(parsed as BodyInputBlob);
  }
  return result;
}

/** RFC 8621 §4.6: the server builds the structure from the flattened form. */
function flatToStructure(
  input: Record<string, unknown>,
  bodyValues: Map<string, string>,
): BodyInput | Rejection {
  const text = parseFlatBody(
    input.textBody,
    "text/plain",
    "textBody",
    bodyValues,
  );
  if (text instanceof Rejection) return text;
  const html = parseFlatBody(
    input.htmlBody,
    "text/html",
    "htmlBody",
    bodyValues,
  );
  if (html instanceof Rejection) return html;
  const attachments = parseFlatAttachments(input.attachments);
  if (attachments instanceof Rejection) return attachments;

  const inline = html
    ? attachments.filter(
        (part) => part.disposition === "inline" && part.cid !== null,
      )
    : [];
  const regular = attachments
    .filter((part) => !inline.includes(part))
    .map((part) => ({
      ...part,
      disposition: part.disposition ?? ("attachment" as const),
    }));

  let rich: BodyInput | null = html;
  if (html && inline.length > 0) {
    rich = {
      kind: "multipart",
      type: "multipart/related",
      subParts: [html, ...inline],
    };
  }
  let body: BodyInput;
  if (text && rich) {
    body = {
      kind: "multipart",
      type: "multipart/alternative",
      subParts: [text, rich],
    };
  } else {
    body = text ??
      rich ?? {
        kind: "text",
        type: "text/plain",
        value: "",
        name: null,
        disposition: null,
        cid: null,
      };
  }
  return regular.length > 0
    ? {
        kind: "multipart",
        type: "multipart/mixed",
        subParts: [body, ...regular],
      }
    : body;
}

export function parseEmailCreate(
  input: unknown,
): ParsedEmailCreate | Rejection {
  if (!isObject(input)) return reject();
  for (const key of Object.keys(input)) {
    if (key === "headers" || key.startsWith("header:")) return reject(key);
    if (SERVER_SET.has(key) || !CREATE_PROPERTIES.has(key)) return reject(key);
  }

  const mailboxIds = input.mailboxIds;
  if (
    !isObject(mailboxIds) ||
    Object.keys(mailboxIds).length !== 1 ||
    Object.values(mailboxIds).some((value) => value !== true)
  ) {
    return reject("mailboxIds");
  }

  const keywords = input.keywords;
  if (
    !isObject(keywords) ||
    Object.values(keywords).some((value) => value !== true)
  ) {
    return reject("keywords");
  }
  const keywordSet = new Set(Object.keys(keywords));
  if (
    !keywordSet.has("$draft") ||
    [...keywordSet].some((keyword) => !DRAFT_KEYWORDS.has(keyword))
  ) {
    return reject("keywords");
  }

  if (!absent(input.sender)) return reject("sender");
  const from = parseAddressList(input.from, 1);
  if (!from || from.length !== 1) return reject("from");
  const to = parseAddressList(input.to, MAX_TO_ENTRIES);
  if (!to) return reject("to");
  const cc = parseAddressList(input.cc, MAX_CC_ENTRIES);
  if (!cc) return reject("cc");
  const bcc = parseAddressList(input.bcc, MAX_BCC_ENTRIES);
  if (!bcc) return reject("bcc");
  let replyTo: ContentAddress[] | null = null;
  if (!absent(input.replyTo)) {
    replyTo = parseAddressList(input.replyTo, MAX_REPLY_TO_ENTRIES);
    if (!replyTo || replyTo.length === 0) return reject("replyTo");
  }

  let subject = "";
  if (!absent(input.subject)) {
    if (
      typeof input.subject !== "string" ||
      HEADER_UNSAFE.test(input.subject) ||
      input.subject.length > MAX_SUBJECT_LENGTH
    ) {
      return reject("subject");
    }
    subject = input.subject;
  }

  let sentAt: string | null = null;
  if (!absent(input.sentAt)) {
    if (
      typeof input.sentAt !== "string" ||
      !RFC3339.test(input.sentAt) ||
      !Number.isFinite(Date.parse(input.sentAt))
    ) {
      return reject("sentAt");
    }
    sentAt = input.sentAt;
  }

  let receivedAt: number | null = null;
  if (!absent(input.receivedAt)) {
    const ms =
      typeof input.receivedAt === "string" && UTC_DATE.test(input.receivedAt)
        ? Date.parse(input.receivedAt)
        : Number.NaN;
    if (!Number.isFinite(ms)) return reject("receivedAt");
    receivedAt = Math.floor(ms / 1000);
  }

  const messageId = parseMessageIds(input.messageId, 1);
  if (!messageId) return reject("messageId");
  const inReplyTo = parseMessageIds(input.inReplyTo, MAX_REFERENCES);
  if (!inReplyTo) return reject("inReplyTo");
  const references = parseMessageIds(input.references, MAX_REFERENCES);
  if (!references) return reject("references");

  const bodyValues = parseBodyValues(input.bodyValues);
  if (!bodyValues) return reject("bodyValues");
  const hasStructure = !absent(input.bodyStructure);
  const hasFlat = ["textBody", "htmlBody", "attachments"].some(
    (key) => !absent(input[key]),
  );
  if (hasStructure && hasFlat) return reject("bodyStructure");

  let body: BodyInput;
  if (hasStructure) {
    const parsed = parseStructurePart(input.bodyStructure, bodyValues, 0);
    if (parsed instanceof Rejection) return parsed;
    if (!isSupportedShape(parsed)) return reject("bodyStructure");
    body = parsed;
  } else {
    const parsed = flatToStructure(input, bodyValues);
    if (parsed instanceof Rejection) return parsed;
    body = parsed;
  }
  if (inputLeaves(body).length > MAX_BODY_LEAVES) {
    return reject(hasStructure ? "bodyStructure" : "attachments");
  }

  return {
    mailboxId: Object.keys(mailboxIds)[0],
    seen: keywordSet.has("$seen"),
    flagged: keywordSet.has("$flagged"),
    from: from[0],
    to,
    cc,
    bcc,
    replyTo,
    subject,
    messageId: messageId.ids ? messageId.ids[0] : null,
    inReplyTo: inReplyTo.ids,
    references: references.ids,
    sentAt,
    receivedAt,
    body,
  };
}
