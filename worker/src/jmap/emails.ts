import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { AllowedInboxes } from "../lib/inbox-permissions";
import {
  queryMessages,
  type MessageFolder,
  type MessageQuery,
} from "../lib/messages/query";
import {
  parseMessageRef,
  serializeMessageRef,
  type AttachmentRow,
  type UnifiedMessage,
} from "../lib/messages/types";
import { customMailboxId, systemMailboxId } from "./ids";
import { loadMailboxDescriptors, type MailboxDescriptor } from "./mailboxes";
import { opaqueState } from "./state";
import { MAX_OBJECTS_IN_GET } from "./constants";

export type JmapMethodError = {
  type: string;
  description?: string;
  properties?: string[];
};

function byteLength(value: string | null | undefined): number {
  return value ? new TextEncoder().encode(value).byteLength : 0;
}

function utcDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function bodyPart(
  messageId: string,
  partId: "text" | "html",
  value: string,
  type: string,
): Record<string, unknown> {
  return {
    partId,
    blobId: `body-${encodeURIComponent(messageId)}-${partId}`,
    size: byteLength(value),
    name: null,
    type,
    charset: "utf-8",
    disposition: null,
    cid: null,
    language: null,
    location: null,
  };
}

function attachmentPart(row: AttachmentRow): Record<string, unknown> {
  return {
    partId: `att-${row.id}`,
    blobId: row.id,
    size: row.size,
    name: row.filename,
    type: row.contentType,
    charset: null,
    disposition: "attachment",
    cid: row.contentId,
    language: null,
    location: null,
  };
}

function threadId(message: UnifiedMessage): string {
  return message.state?.conversationKey ?? serializeMessageRef(message.ref);
}

function systemMailboxForMessage(message: UnifiedMessage): string | null {
  const state = message.state;
  const inbox = message.inbox.toLowerCase();

  if (state?.trashedAt) return systemMailboxId(inbox, "trash");
  if (message.direction === "outbound") return systemMailboxId(inbox, "sent");
  if (state?.spamAt) return systemMailboxId(inbox, "junk");
  if (state?.archivedAt) return systemMailboxId(inbox, "archive");
  if (
    state?.snoozedUntil &&
    state.snoozedUntil > Math.floor(Date.now() / 1000)
  ) {
    return null;
  }
  return systemMailboxId(inbox, "inbox");
}

function mailboxIds(message: UnifiedMessage): Record<string, true> {
  const ids: Record<string, true> = {};
  const system = systemMailboxForMessage(message);
  if (system) ids[system] = true;
  for (const mailboxId of message.state?.mailboxIds ?? []) {
    ids[customMailboxId(mailboxId)] = true;
  }
  return ids;
}

function keywords(message: UnifiedMessage): Record<string, true> {
  const result: Record<string, true> = {};
  if (message.state?.seen) result.$seen = true;
  if (message.state?.starredAt) result.$flagged = true;
  return result;
}

function emailAddress(
  address: { email: string; name?: string | null } | null,
): Record<string, unknown> | null {
  if (!address) return null;
  return { email: address.email, name: address.name ?? null };
}

function bodyValues(
  message: UnifiedMessage,
  fetchText: boolean,
  fetchHtml: boolean,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (fetchText && message.bodyText !== null) {
    values.text = {
      value: message.bodyText,
      isEncodingProblem: false,
      isTruncated: false,
    };
  }
  if (fetchHtml && message.bodyHtml !== null) {
    values.html = {
      value: message.bodyHtml,
      isEncodingProblem: false,
      isTruncated: false,
    };
  }
  return values;
}

function approximateSize(message: UnifiedMessage): number {
  const addressBytes = [
    message.from?.email,
    message.from?.name,
    message.to.email,
    message.to.name,
    ...message.cc.flatMap((address) => [address.email, address.name]),
  ].reduce<number>((sum, value) => sum + byteLength(value), 0);
  const attachmentBytes = (message.attachments ?? []).reduce(
    (sum, attachment) => sum + attachment.size,
    0,
  );
  return (
    byteLength(message.subject) +
    byteLength(message.bodyText) +
    byteLength(message.bodyHtml) +
    addressBytes +
    attachmentBytes
  );
}

function supportedProperties(
  full: Record<string, unknown>,
  properties: unknown,
): Record<string, unknown> | null {
  if (properties === undefined || properties === null) return full;
  if (
    !Array.isArray(properties) ||
    !properties.every((property) => typeof property === "string")
  ) {
    return null;
  }

  const selected: Record<string, unknown> = { id: full.id };
  for (const property of properties as string[]) {
    if (property in full) selected[property] = full[property];
  }
  return selected;
}

export function toJmapEmail(
  message: UnifiedMessage,
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  const id = serializeMessageRef(message.ref);
  const attachments = message.attachments ?? [];
  const textBody = message.bodyText
    ? [bodyPart(id, "text", message.bodyText, "text/plain")]
    : [];
  const htmlBody = message.bodyHtml
    ? [bodyPart(id, "html", message.bodyHtml, "text/html")]
    : [];
  const preview = (message.bodyText ?? "").slice(0, 256);
  const from = emailAddress(message.from);
  const full: Record<string, unknown> = {
    id,
    threadId: threadId(message),
    mailboxIds: mailboxIds(message),
    keywords: keywords(message),
    size: approximateSize(message),
    receivedAt: utcDate(message.occurredAt),
    sentAt:
      message.direction === "outbound" ? utcDate(message.occurredAt) : null,
    from: from ? [from] : [],
    to: [emailAddress(message.to)],
    cc: message.cc.map((address) => emailAddress(address)),
    subject: message.subject ?? "",
    preview,
    hasAttachment: attachments.length > 0,
    textBody,
    htmlBody,
    attachments: attachments.map(attachmentPart),
    bodyValues: bodyValues(
      message,
      args.fetchTextBodyValues === true,
      args.fetchHTMLBodyValues === true,
    ),
  };
  return supportedProperties(full, args.properties);
}

async function allVisibleMessages(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  extra: MessageQuery = {},
): Promise<UnifiedMessage[]> {
  const page = await queryMessages(db, allowed, {
    ...extra,
    limit: null,
    viewer: { userId },
    withState: true,
    withAttachments: true,
  });
  return page.messages;
}

export async function emailGet(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  accountId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | JmapMethodError> {
  const ids = args.ids;
  if (
    ids !== undefined &&
    ids !== null &&
    (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
  ) {
    return { type: "invalidArguments", properties: ["ids"] };
  }
  if (Array.isArray(ids) && ids.length > MAX_OBJECTS_IN_GET) {
    return {
      type: "invalidArguments",
      description: `ids exceeds maxObjectsInGet (${MAX_OBJECTS_IN_GET})`,
      properties: ["ids"],
    };
  }

  const visible = await allVisibleMessages(db, allowed, userId);
  const byId = new Map(
    visible.map((message) => [serializeMessageRef(message.ref), message]),
  );

  let requestedIds: string[];
  if (ids === undefined || ids === null) {
    if (visible.length > MAX_OBJECTS_IN_GET) {
      return {
        type: "invalidArguments",
        description: `Email/get without ids exceeds maxObjectsInGet (${MAX_OBJECTS_IN_GET})`,
      };
    }
    requestedIds = visible.map((message) => serializeMessageRef(message.ref));
  } else {
    requestedIds = ids as string[];
  }

  const list: Record<string, unknown>[] = [];
  const notFound: string[] = [];
  for (const id of requestedIds) {
    if (!parseMessageRef(id)) {
      notFound.push(id);
      continue;
    }
    const message = byId.get(id);
    if (!message) {
      notFound.push(id);
      continue;
    }
    const email = toJmapEmail(message, args);
    if (!email) return { type: "invalidArguments", properties: ["properties"] };
    list.push(email);
  }

  return {
    accountId,
    state: await emailState(visible),
    list,
    notFound,
  };
}

function parseDate(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed / 1000;
}

function hasOnlySupportedFilterFields(
  filter: Record<string, unknown>,
): boolean {
  const allowed = new Set([
    "inMailbox",
    "text",
    "from",
    "after",
    "before",
    "hasKeyword",
    "notKeyword",
  ]);
  return Object.keys(filter).every((key) => allowed.has(key));
}

function includesText(message: UnifiedMessage, needle: string): boolean {
  const haystack = [
    message.subject,
    message.bodyText,
    message.bodyHtml,
    message.from?.email,
    message.from?.name,
    message.to.email,
    message.to.name,
    ...message.cc.flatMap((address) => [address.email, address.name]),
  ]
    .filter((value): value is string => typeof value === "string")
    .join("\n")
    .toLowerCase();
  return haystack.includes(needle.toLowerCase());
}

function keywordValue(message: UnifiedMessage, keyword: string): boolean {
  if (keyword === "$seen") return message.state?.seen === true;
  if (keyword === "$flagged") return Boolean(message.state?.starredAt);
  return false;
}

function descriptorFolder(descriptor: MailboxDescriptor): MessageFolder | null {
  if (descriptor.kind === "custom") {
    return { mailboxId: descriptor.mailboxId };
  }
  if (descriptor.role === "drafts") return null;
  return descriptor.role;
}

export async function emailQuery(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  accountId: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown> | JmapMethodError> {
  if (args.collapseThreads !== undefined && args.collapseThreads !== false) {
    return { type: "invalidArguments", properties: ["collapseThreads"] };
  }

  if (args.sort !== undefined && args.sort !== null) {
    if (!Array.isArray(args.sort) || args.sort.length !== 1) {
      return { type: "unsupportedSort" };
    }
    const comparator = args.sort[0];
    if (
      typeof comparator !== "object" ||
      comparator === null ||
      (comparator as Record<string, unknown>).property !== "receivedAt" ||
      (comparator as Record<string, unknown>).isAscending === true ||
      ((comparator as Record<string, unknown>).collation !== undefined &&
        (comparator as Record<string, unknown>).collation !== null)
    ) {
      return { type: "unsupportedSort" };
    }
  }

  const filterValue = args.filter ?? {};
  if (
    typeof filterValue !== "object" ||
    filterValue === null ||
    Array.isArray(filterValue)
  ) {
    return { type: "invalidArguments", properties: ["filter"] };
  }
  const filter = filterValue as Record<string, unknown>;
  if (!hasOnlySupportedFilterFields(filter)) {
    return { type: "invalidArguments", properties: ["filter"] };
  }

  for (const stringField of ["inMailbox", "text", "from"] as const) {
    if (
      filter[stringField] !== undefined &&
      typeof filter[stringField] !== "string"
    ) {
      return { type: "invalidArguments", properties: ["filter"] };
    }
  }
  for (const keywordField of ["hasKeyword", "notKeyword"] as const) {
    const value = filter[keywordField];
    if (
      value !== undefined &&
      (typeof value !== "string" || (value !== "$seen" && value !== "$flagged"))
    ) {
      return { type: "invalidArguments", properties: ["filter"] };
    }
  }

  const after = parseDate(filter.after);
  const before = parseDate(filter.before);
  if (after === null || before === null) {
    return { type: "invalidArguments", properties: ["filter"] };
  }

  const position = args.position === undefined ? 0 : args.position;
  const limit = args.limit === undefined ? 50 : args.limit;
  if (
    typeof position !== "number" ||
    !Number.isInteger(position) ||
    position < 0 ||
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 0
  ) {
    return { type: "invalidArguments", properties: ["position", "limit"] };
  }

  let queryExtra: MessageQuery = { order: "desc" };
  if (typeof filter.inMailbox === "string") {
    const descriptors = await loadMailboxDescriptors(db, allowed);
    const descriptor = descriptors.find((item) => item.id === filter.inMailbox);
    if (!descriptor) {
      return {
        accountId,
        queryState: await opaqueState([]),
        canCalculateChanges: false,
        position,
        ids: [],
        total: 0,
      };
    }
    const folder = descriptorFolder(descriptor);
    if (!folder) {
      return {
        accountId,
        queryState: await opaqueState([descriptor.id, "empty"]),
        canCalculateChanges: false,
        position,
        ids: [],
        total: 0,
      };
    }
    queryExtra = {
      ...queryExtra,
      inboxes: [descriptor.inbox],
      folder,
    };
  }

  let messages = await allVisibleMessages(db, allowed, userId, queryExtra);
  messages = messages.filter((message) => {
    if (after !== undefined && message.occurredAt <= after) return false;
    if (before !== undefined && message.occurredAt >= before) return false;
    if (
      typeof filter.text === "string" &&
      !includesText(message, filter.text)
    ) {
      return false;
    }
    if (
      typeof filter.from === "string" &&
      !(message.from?.email ?? "")
        .toLowerCase()
        .includes(filter.from.toLowerCase())
    ) {
      return false;
    }
    if (
      typeof filter.hasKeyword === "string" &&
      !keywordValue(message, filter.hasKeyword)
    ) {
      return false;
    }
    if (
      typeof filter.notKeyword === "string" &&
      keywordValue(message, filter.notKeyword)
    ) {
      return false;
    }
    return true;
  });
  messages.sort(
    (a, b) =>
      b.occurredAt - a.occurredAt ||
      serializeMessageRef(a.ref).localeCompare(serializeMessageRef(b.ref)),
  );

  const ids = messages.map((message) => serializeMessageRef(message.ref));
  return {
    accountId,
    queryState: await opaqueState(ids),
    canCalculateChanges: false,
    position,
    ids: ids.slice(position, position + limit),
    total: ids.length,
  };
}

export async function emailState(messages: UnifiedMessage[]): Promise<string> {
  return opaqueState(
    messages.map((message) => ({
      id: serializeMessageRef(message.ref),
      occurredAt: message.occurredAt,
      seen: message.state?.seen,
      starredAt: message.state?.starredAt,
      archivedAt: message.state?.archivedAt,
      spamAt: message.state?.spamAt,
      trashedAt: message.state?.trashedAt,
      mailboxIds: message.state?.mailboxIds,
      attachments: (message.attachments ?? []).map((attachment) => [
        attachment.id,
        attachment.size,
      ]),
    })),
  );
}

export async function visibleMessagesForThreads(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
): Promise<UnifiedMessage[]> {
  return allVisibleMessages(db, allowed, userId, { order: "asc" });
}

export { threadId as jmapThreadId };
