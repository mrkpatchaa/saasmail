import { and, eq, lt } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { emails } from "../db/emails.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import {
  SYSTEM_INBOX_ACCESS,
  deleteEmailWithAttachments,
} from "./delete-email";
import { decodeEntities, htmlToText } from "./html-to-text";
import { isInboxAllowed, type AllowedInboxes } from "./inbox-permissions";
import { queryMessages } from "./messages/query";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/** Days a test inbox keeps its mail when it names none. */
export const DEFAULT_TEST_RETENTION_DAYS = 3;
export const MIN_TEST_RETENTION_DAYS = 1;
export const MAX_TEST_RETENTION_DAYS = 30;
/** Longest wait one call may ask for, in seconds. */
export const MAX_WAIT_SECONDS = 30;
export const DEFAULT_WAIT_SECONDS = 25;

const MAX_LINKS = 20;
const MAX_CODES = 10;

/** Characters that end a URL written in plain text. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

/**
 * The `http(s)` URLs of a message: the HTML's `href`s (entities decoded, so
 * `&amp;` is `&`), then the URLs written in the text. Deduplicated, in order,
 * at most 20.
 */
export function extractLinks(
  html: string | null,
  text: string | null,
): string[] {
  const found: string[] = [];
  if (html) {
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    for (const match of html.matchAll(href)) {
      found.push(decodeEntities(match[1] ?? match[2] ?? match[3] ?? "").trim());
    }
  }
  if (text) {
    for (const match of text.matchAll(/https?:\/\/[^\s<>"]+/gi)) {
      found.push(match[0].replace(TRAILING_PUNCTUATION, ""));
    }
  }
  const links: string[] = [];
  for (const url of found) {
    if (!/^https?:\/\/\S+$/i.test(url) || links.includes(url)) continue;
    links.push(url);
    if (links.length === MAX_LINKS) break;
  }
  return links;
}

/**
 * Candidate one-time codes: whole runs of 4–8 digits (not part of a longer
 * run) in the subject, then the text. Deduplicated, in order, at most 10.
 */
export function extractCodes(
  subject: string | null,
  text: string | null,
): string[] {
  const codes: string[] = [];
  for (const source of [subject, text]) {
    if (!source) continue;
    for (const match of source.matchAll(/(?<!\d)\d{4,8}(?!\d)/g)) {
      if (codes.includes(match[0])) continue;
      codes.push(match[0]);
      if (codes.length === MAX_CODES) return codes;
    }
  }
  return codes;
}

export interface TestMailQuery {
  inbox: string;
  /** Exact `+detail`, any case. */
  detail?: string;
  /** Epoch seconds: only mail received at or after it. */
  since: number;
  /** Case-insensitive substring of the subject. */
  subject?: string;
  /** Exact sender address. */
  from?: string;
  /** Seconds, 1–30. */
  timeout: number;
}

export interface TestMail {
  id: string;
  inbox: string;
  detail: string | null;
  from: string | null;
  subject: string | null;
  receivedAt: number;
  text: string | null;
  html: string | null;
  links: string[];
  codes: string[];
}

export interface WaitDeps {
  /** Stops the wait early (the request was aborted). */
  signal?: AbortSignal;
  /** Milliseconds; injectable for tests. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Whether the caller may wait on this inbox: it may read it, and it is a test
 * inbox. One answer for both, so a refusal says nothing about the inbox.
 */
export async function mayWaitOn(
  db: Db,
  allowed: AllowedInboxes,
  inbox: string,
): Promise<boolean> {
  if (!isInboxAllowed(allowed, inbox)) return false;
  const [row] = await db
    .select({ purpose: senderIdentities.purpose })
    .from(senderIdentities)
    .where(eq(senderIdentities.email, inbox))
    .limit(1);
  return row?.purpose === "test";
}

/** The first message to the test inbox that matches, or null. */
async function findTestMail(
  db: Db,
  allowed: AllowedInboxes,
  query: TestMailQuery,
): Promise<TestMail | null> {
  const page = await queryMessages(db, allowed, {
    inboxes: [query.inbox],
    direction: "inbound",
    after: query.since,
    order: "asc",
    includeArchived: true,
    includeSnoozed: true,
    ...(query.detail !== undefined
      ? { recipientDetail: query.detail.toLowerCase() }
      : {}),
    ...(query.from !== undefined ? { fromExact: query.from } : {}),
    ...(query.subject !== undefined
      ? { search: query.subject, searchMode: "subject" as const }
      : {}),
    limit: 5,
  });
  const message = page.messages[0];
  if (!message) return null;
  const text = message.bodyText;
  const html = message.bodyHtml;
  return {
    id: message.ref.id,
    inbox: message.inbox,
    detail: message.recipientDetail ?? null,
    from: message.from?.email ?? null,
    subject: message.subject,
    receivedAt: message.occurredAt,
    text,
    html,
    links: extractLinks(html, text),
    codes: extractCodes(
      message.subject,
      text ?? (html ? htmlToText(html) : null),
    ),
  };
}

/**
 * Waits up to `timeout` seconds for the first message to a test inbox that
 * matches. Polls D1 (at once, after 1 s, then every 2 s); null on timeout or
 * when `signal` aborts. `error` is set when the caller may not wait on the
 * inbox (not readable, or not a test inbox).
 */
export async function waitForTestMail(
  db: Db,
  allowed: AllowedInboxes,
  input: TestMailQuery,
  deps: WaitDeps = {},
): Promise<{ error: "forbidden" | null; message: TestMail | null }> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? realSleep;
  const query = { ...input, inbox: input.inbox.trim().toLowerCase() };
  if (!(await mayWaitOn(db, allowed, query.inbox))) {
    return { error: "forbidden", message: null };
  }
  const deadline = now() + query.timeout * 1000;
  let interval = 1000;
  for (;;) {
    const message = await findTestMail(db, allowed, query);
    if (message) return { error: null, message };
    const remaining = deadline - now();
    if (remaining <= 0 || deps.signal?.aborted) break;
    await sleep(Math.min(interval, remaining), deps.signal);
    if (deps.signal?.aborted) break;
    interval = 2000;
  }
  return { error: null, message: null };
}

const PRUNE_BATCH = 200;
const PRUNE_MAX_BATCHES = 5;

/**
 * Deletes test-inbox mail older than its inbox's retention, through the
 * normal delete path (attachments, mailbox state, the row). At most 5 batches
 * of 200 per pass; the next hourly pass takes the rest. Returns how many.
 */
export async function pruneTestMail(
  db: Db,
  env: CloudflareBindings,
  now: number,
): Promise<number> {
  const inboxes = await db
    .select({
      email: senderIdentities.email,
      days: senderIdentities.testRetentionDays,
    })
    .from(senderIdentities)
    .where(eq(senderIdentities.purpose, "test"));
  let batches = 0;
  let deleted = 0;
  for (const inbox of inboxes) {
    const cutoff =
      now - (inbox.days ?? DEFAULT_TEST_RETENTION_DAYS) * 24 * 60 * 60;
    while (batches < PRUNE_MAX_BATCHES) {
      const rows = await db
        .select({ id: emails.id })
        .from(emails)
        .where(
          and(eq(emails.recipient, inbox.email), lt(emails.receivedAt, cutoff)),
        )
        .limit(PRUNE_BATCH);
      if (rows.length === 0) break;
      batches++;
      for (const row of rows) {
        const result = await deleteEmailWithAttachments(
          db,
          env.R2,
          row.id,
          SYSTEM_INBOX_ACCESS,
        );
        if (result) deleted++;
      }
      if (rows.length < PRUNE_BATCH) break;
    }
    if (batches >= PRUNE_MAX_BATCHES) break;
  }
  return deleted;
}
