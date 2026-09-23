import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { inboxScopeSql, type AllowedInboxes } from "../lib/inbox-permissions";
import { listAllowedInboxAddresses } from "./mailboxes";

export async function opaqueState(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `s-${hex.slice(0, 32)}`;
}

type StateAggregate = {
  received_count: number;
  received_max: number | null;
  sent_count: number;
  sent_max: number | null;
  user_state_count: number;
  user_state_max: number | null;
  mailbox_state_count: number;
  mailbox_state_max: number | null;
  membership_count: number;
  membership_max: number | null;
  mailbox_count: number;
  mailbox_max: number | null;
  identity_count: number;
  identity_max: number | null;
};

export async function jmapState(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
): Promise<string> {
  const receivedScope = inboxScopeSql(allowed, sql`e.recipient`);
  const sentScope = inboxScopeSql(allowed, sql`se.from_address`);
  const mailboxStateScope = inboxScopeSql(allowed, sql`mms.inbox`);
  const mailboxScope = inboxScopeSql(allowed, sql`mb.inbox`);
  const identityScope = inboxScopeSql(allowed, sql`si.email`);

  const rows = await db.all<StateAggregate>(sql`
    SELECT
      (SELECT COUNT(*) FROM emails e WHERE 1 = 1 ${receivedScope}) AS received_count,
      (SELECT MAX(e.received_at) FROM emails e WHERE 1 = 1 ${receivedScope}) AS received_max,
      (SELECT COUNT(*) FROM sent_emails se WHERE 1 = 1 ${sentScope}) AS sent_count,
      (SELECT MAX(se.sent_at) FROM sent_emails se WHERE 1 = 1 ${sentScope}) AS sent_max,
      (SELECT COUNT(*) FROM message_user_state mus WHERE mus.user_id = ${userId}) AS user_state_count,
      (SELECT MAX(mus.updated_at) FROM message_user_state mus WHERE mus.user_id = ${userId}) AS user_state_max,
      (SELECT COUNT(*) FROM mailbox_message_state mms WHERE 1 = 1 ${mailboxStateScope}) AS mailbox_state_count,
      (SELECT MAX(mms.updated_at) FROM mailbox_message_state mms WHERE 1 = 1 ${mailboxStateScope}) AS mailbox_state_max,
      (SELECT COUNT(*)
         FROM message_mailboxes mm
         JOIN mailboxes mb ON mb.id = mm.mailbox_id
        WHERE 1 = 1 ${mailboxScope}) AS membership_count,
      (SELECT MAX(mm.added_at)
         FROM message_mailboxes mm
         JOIN mailboxes mb ON mb.id = mm.mailbox_id
        WHERE 1 = 1 ${mailboxScope}) AS membership_max,
      (SELECT COUNT(*) FROM mailboxes mb WHERE 1 = 1 ${mailboxScope}) AS mailbox_count,
      (SELECT MAX(mb.updated_at) FROM mailboxes mb WHERE 1 = 1 ${mailboxScope}) AS mailbox_max,
      (SELECT COUNT(*) FROM sender_identities si WHERE 1 = 1 ${identityScope}) AS identity_count,
      (SELECT MAX(si.updated_at) FROM sender_identities si WHERE 1 = 1 ${identityScope}) AS identity_max
  `);

  return opaqueState(rows[0] ?? {});
}

export type ParsedJmapState = {
  seq: number;
  issuedAt: number;
  fp: string;
};

export function formatJmapState(
  seq: number,
  issuedAt: number,
  fp: string,
): string {
  return `j1-${seq}-${issuedAt}-${fp}`;
}

export function parseJmapState(value: unknown): ParsedJmapState | null {
  if (typeof value !== "string") return null;
  const match = /^j1-(\d+)-(\d+)-([0-9a-f]{16})$/.exec(value);
  if (!match) return null;
  const seq = Number(match[1]);
  const issuedAt = Number(match[2]);
  if (!Number.isSafeInteger(seq) || !Number.isSafeInteger(issuedAt))
    return null;
  return { seq, issuedAt, fp: match[3] };
}

async function stateFingerprint(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
): Promise<string> {
  const inboxes = await listAllowedInboxAddresses(db, allowed);
  const bytes = new TextEncoder().encode(`${userId}\n${inboxes.join(",")}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, 16);
}

export async function currentJmapState(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  now = Math.floor(Date.now() / 1000),
): Promise<{ state: string; parts: ParsedJmapState }> {
  const inboxScope = inboxScopeSql(allowed, sql`jc.inbox`);
  const rows = await db.all<{ seq: number }>(sql`
    SELECT COALESCE(MAX(jc.seq), 0) AS seq
    FROM jmap_changes jc
    WHERE 1 = 1
      ${inboxScope}
      AND (jc.user_id IS NULL OR jc.user_id = ${userId})
  `);
  const seq = Number(rows[0]?.seq ?? 0);
  const fp = await stateFingerprint(db, allowed, userId);
  const parts = { seq, issuedAt: now, fp };
  return { state: formatJmapState(seq, now, fp), parts };
}
