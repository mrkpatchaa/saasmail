import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { emails } from "../../db/emails.schema";
import { jmapMessageContent } from "../../db/jmap-message-content.schema";
import { sentEmails } from "../../db/sent-emails.schema";
import { toBase64 } from "../email-sender/shared";
import type { MailAddress, UnifiedMessage } from "../messages/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

export interface RenderedMessage {
  bytes: Uint8Array<ArrayBuffer>;
  /** The bytes as received or sent, not rebuilt from what was stored. */
  exact: boolean;
  /** For the mbox separator line. */
  envelopeFrom: string;
  date: Date;
}

const CRLF = "\r\n";
const encoder = new TextEncoder();
const PRINTABLE = /^[\x20-\x7e]*$/;

/** Received-mail headers a rebuilt message keeps, when they were stored. */
const KEPT_HEADERS = [
  "list-id",
  "list-unsubscribe",
  "list-unsubscribe-post",
  "auto-submitted",
  "authentication-results",
  "received-spf",
  "dkim-signature",
  "x-spam-score",
];

/** An RFC 2047 encoded word when the text is not plain ASCII. */
function headerText(value: string): string {
  if (PRINTABLE.test(value)) return value;
  return `=?UTF-8?B?${toBase64(encoder.encode(value))}?=`;
}

function mailbox(address: MailAddress): string {
  const email = oneLine(address.email);
  if (!address.name) return email;
  const name = PRINTABLE.test(address.name)
    ? `"${address.name.replace(/["\\]/g, "\\$&")}"`
    : headerText(address.name);
  return `${name} <${email}>`;
}

/** RFC 5322 date-time in UTC. */
export function rfc5322Date(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

/** A stored value as one header line: no CR or LF can start a new header. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

/** Base64 in 76-character lines. */
function wrappedBase64(bytes: Uint8Array): string {
  const encoded = toBase64(bytes);
  const lines: string[] = [];
  for (let i = 0; i < encoded.length; i += 76) {
    lines.push(encoded.slice(i, i + 76));
  }
  return lines.join(CRLF);
}

/**
 * Fixed per message, so rendering the same message twice gives the same bytes
 * (a retried export slice re-uploads identical parts). The parts it separates
 * are base64, which cannot contain it.
 */
function boundary(kind: string, ref: { kind: string; id: string }): string {
  const id = `${ref.kind}-${ref.id}`.replace(/[^A-Za-z0-9_-]/g, "_");
  return `saasmail-${kind}-${id}`.slice(0, 70);
}

/** `/api/attachments/{id}/inline` back to the `cid:` it was rewritten from. */
function restoreCids(
  html: string,
  inline: { id: string; contentId: string }[],
): string {
  let restored = html;
  for (const attachment of inline) {
    restored = restored.replaceAll(
      `/api/attachments/${attachment.id}/inline`,
      `cid:${attachment.contentId.replace(/^<|>$/g, "")}`,
    );
  }
  return restored;
}

function textPart(contentType: string, text: string): string {
  return [
    `Content-Type: ${contentType}; charset=utf-8`,
    "Content-Transfer-Encoding: base64",
    "",
    wrappedBase64(encoder.encode(text.replace(/\r?\n/g, CRLF))),
  ].join(CRLF);
}

/**
 * The bytes of one message, for an `.eml` download or an mbox export: the
 * bytes as received when they were kept (`emails.raw_r2_key`), the stored
 * message of a JMAP send, and otherwise a faithful rebuild from the stored
 * headers, bodies and attachments, marked `X-Saasmail-Reconstructed: yes`.
 * `message` comes from `queryMessages` with attachments.
 */
export async function renderMessageBytes(
  db: Db,
  env: CloudflareBindings,
  message: UnifiedMessage,
): Promise<RenderedMessage> {
  const date = new Date(message.occurredAt * 1000);
  const envelopeFrom =
    message.from?.email ??
    (message.direction === "outbound" ? message.inbox : "MAILER-DAEMON");

  const exactKey = await exactBytesKey(db, message);
  if (exactKey) {
    const object = await env.R2.get(exactKey);
    if (object) {
      return {
        bytes: new Uint8Array(await object.arrayBuffer()),
        exact: true,
        envelopeFrom,
        date,
      };
    }
  }

  const headers: string[] = [
    `Date: ${rfc5322Date(date)}`,
    ...(message.from ? [`From: ${mailbox(message.from)}`] : []),
    `To: ${[message.to, ...(message.additionalTo ?? [])].map(mailbox).join(", ")}`,
  ];
  if (message.cc.length > 0) {
    headers.push(`Cc: ${message.cc.map(mailbox).join(", ")}`);
  }
  if ((message.bcc?.length ?? 0) > 0) {
    headers.push(`Bcc: ${message.bcc!.map(mailbox).join(", ")}`);
  }
  if ((message.replyTo?.length ?? 0) > 0) {
    headers.push(`Reply-To: ${message.replyTo!.map(mailbox).join(", ")}`);
  }
  headers.push(`Subject: ${headerText(message.subject ?? "")}`);
  if (message.messageId) {
    const id = oneLine(message.messageId).replace(/^<|>$/g, "");
    headers.push(`Message-ID: <${id}>`);
  }
  if (message.inReplyTo) {
    headers.push(`In-Reply-To: ${oneLine(message.inReplyTo)}`);
  }
  if (message.references) {
    headers.push(`References: ${oneLine(message.references)}`);
  }
  if (message.direction === "inbound") {
    for (const [name, value] of Object.entries(
      await storedHeaders(db, message.ref.id),
    )) {
      if (
        KEPT_HEADERS.includes(name.toLowerCase()) &&
        /^[\x20-\x7e\t]*$/.test(value) &&
        value.trim() !== ""
      ) {
        headers.push(`${name}: ${value}`);
      }
    }
  }
  headers.push("MIME-Version: 1.0", "X-Saasmail-Reconstructed: yes");

  const attachments = message.attachments ?? [];
  const inline = attachments
    .filter((attachment) => attachment.contentId)
    .map((attachment) => ({
      id: attachment.id,
      contentId: attachment.contentId!,
    }));
  const html = message.bodyHtml ? restoreCids(message.bodyHtml, inline) : null;
  const text = message.bodyText;

  let body: string;
  if (text !== null && html !== null) {
    const alt = boundary("alt", message.ref);
    body = [
      `Content-Type: multipart/alternative; boundary="${alt}"`,
      "",
      `--${alt}`,
      textPart("text/plain", text),
      `--${alt}`,
      textPart("text/html", html),
      `--${alt}--`,
    ].join(CRLF);
  } else {
    body = textPart(
      html !== null ? "text/html" : "text/plain",
      html ?? text ?? "",
    );
  }

  const segments: (string | Uint8Array)[] = [`${headers.join(CRLF)}${CRLF}`];
  if (attachments.length > 0) {
    const mixed = boundary("mixed", message.ref);
    segments.push(
      `Content-Type: multipart/mixed; boundary="${mixed}"${CRLF}${CRLF}--${mixed}${CRLF}${body}`,
    );
    for (const attachment of attachments) {
      const object = await env.R2.get(attachment.r2Key);
      if (!object) continue;
      const name = attachment.filename.replace(/["\\\r\n]/g, "_");
      const encodedName = PRINTABLE.test(name)
        ? `filename="${name}"`
        : `filename*=UTF-8''${encodeURIComponent(name)}`;
      const contentId = attachment.contentId
        ? oneLine(attachment.contentId).replace(/^<|>$/g, "")
        : null;
      const partHeaders = [
        `Content-Type: ${oneLine(attachment.contentType)}`,
        "Content-Transfer-Encoding: base64",
        contentId
          ? `Content-Disposition: inline; ${encodedName}`
          : `Content-Disposition: attachment; ${encodedName}`,
        ...(contentId ? [`Content-ID: <${contentId}>`] : []),
      ];
      segments.push(
        `${CRLF}--${mixed}${CRLF}${partHeaders.join(CRLF)}${CRLF}${CRLF}`,
        wrappedBase64Bytes(new Uint8Array(await object.arrayBuffer())),
      );
    }
    segments.push(`${CRLF}--${mixed}--`);
  } else {
    segments.push(body);
  }
  segments.push(CRLF);

  return {
    bytes: concatSegments(segments),
    exact: false,
    envelopeFrom,
    date,
  };
}

/** 64 lines of 76 characters. */
const BASE64_BLOCK = 57 * 64;

/**
 * Base64 in 76-character CRLF lines, written as bytes a block at a time, so
 * a large attachment never becomes one long string.
 */
function wrappedBase64Bytes(bytes: Uint8Array): Uint8Array {
  const encodedLength = Math.ceil(bytes.length / 3) * 4;
  const lines = Math.max(1, Math.ceil(encodedLength / 76));
  const out = new Uint8Array(encodedLength + 2 * (lines - 1));
  let offset = 0;
  for (let i = 0; i < bytes.length; i += BASE64_BLOCK) {
    const encoded = toBase64(bytes.subarray(i, i + BASE64_BLOCK));
    for (let j = 0; j < encoded.length; j++) {
      if (j % 76 === 0 && offset > 0) {
        out[offset++] = CR;
        out[offset++] = NL;
      }
      out[offset++] = encoded.charCodeAt(j);
    }
  }
  return out;
}

function concatSegments(
  segments: (string | Uint8Array)[],
): Uint8Array<ArrayBuffer> {
  const parts = segments.map((segment) =>
    typeof segment === "string" ? encoder.encode(segment) : segment,
  );
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Where the message's own bytes are kept, if they are. */
async function exactBytesKey(
  db: Db,
  message: UnifiedMessage,
): Promise<string | null> {
  if (message.ref.kind === "received") {
    const [row] = await db
      .select({ key: emails.rawR2Key })
      .from(emails)
      .where(eq(emails.id, message.ref.id))
      .limit(1);
    return row?.key ?? null;
  }
  const [row] = await db
    .select({ key: jmapMessageContent.rawR2Key })
    .from(sentEmails)
    .innerJoin(
      jmapMessageContent,
      eq(jmapMessageContent.id, sentEmails.jmapContentId),
    )
    .where(eq(sentEmails.id, message.ref.id))
    .limit(1);
  return row?.key ?? null;
}

/** A received message's stored headers (postal-mime's map). */
async function storedHeaders(
  db: Db,
  emailId: string,
): Promise<Record<string, string>> {
  const [row] = await db
    .select({ raw: emails.rawHeaders })
    .from(emails)
    .where(eq(emails.id, emailId))
    .limit(1);
  if (!row?.raw) return {};
  try {
    const parsed = JSON.parse(row.raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
}

/** asctime, as mbox separator lines carry it: "Sat Oct  3 14:02:00 2026". */
export function asctime(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, " ")} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} ${date.getUTCFullYear()}`;
}

const NL = 0x0a;
const CR = 0x0d;
const GT = 0x3e;
const FROM_ = encoder.encode("From ");

/** Whether the line from `start` to `end` is `>*From `, which mboxrd quotes. */
function needsQuote(source: Uint8Array, start: number, end: number): boolean {
  let probe = start;
  while (probe < end && source[probe] === GT) probe++;
  if (probe + FROM_.length > end) return false;
  for (let i = 0; i < FROM_.length; i++) {
    if (source[probe + i] !== FROM_[i]) return false;
  }
  return true;
}

/** Calls `visit` with each line's start and end (before any CR, then LF). */
function eachLine(
  source: Uint8Array,
  visit: (start: number, end: number, last: boolean) => void,
): void {
  let start = 0;
  for (;;) {
    let next = source.indexOf(NL, start);
    const last = next === -1;
    if (last) next = source.length;
    let end = next;
    if (end > start && source[end - 1] === CR) end--;
    visit(start, end, last);
    if (last) return;
    start = next + 1;
  }
}

/**
 * One mbox entry (mboxrd): the separator line, then `headers` (saasmail's
 * own, one per line), then the message with CRLF made LF and every line that
 * is `From ` after any number of `>` given one more `>`, then a blank line.
 * Sized exactly, so a large message is copied once.
 */
export function mboxEntry(
  rendered: RenderedMessage,
  headers: string[] = [],
): Uint8Array {
  const prefix = encoder.encode(
    `From ${rendered.envelopeFrom.replace(/\s/g, "") || "MAILER-DAEMON"} ${asctime(rendered.date)}\n` +
      headers.map((header) => `${oneLine(header)}\n`).join(""),
  );
  const source = rendered.bytes;
  let size = prefix.length + 2;
  eachLine(source, (start, end, last) => {
    size += end - start + (needsQuote(source, start, end) ? 1 : 0);
    if (!last) size++;
  });
  const out = new Uint8Array(size);
  out.set(prefix, 0);
  let length = prefix.length;
  eachLine(source, (start, end, last) => {
    if (needsQuote(source, start, end)) out[length++] = GT;
    out.set(source.subarray(start, end), length);
    length += end - start;
    if (!last) out[length++] = NL;
  });
  // The message ends with a newline, then a blank line ends the entry.
  if (out[length - 1] !== NL) out[length++] = NL;
  out[length++] = NL;
  return out.subarray(0, length);
}
