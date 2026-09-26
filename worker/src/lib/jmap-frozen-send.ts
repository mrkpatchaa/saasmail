import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { jmapMessageContent } from "../db/jmap-message-content.schema";
import { jmapSubmissions } from "../db/jmap-submissions.schema";
import { contentLeaves, type JmapContentRow } from "../jmap/content";
import type { SendEmailAttachment } from "./email-sender";
import type { CcRecipient } from "./send";
import { buildSubmissionMessage } from "./submit-message";

// Note: outbox.ts -> jmap-frozen-send.ts -> submit-message.ts -> outbox.ts is an
// import cycle. It is safe because every module only exports functions that
// are called later, never at evaluation time. Don't add top-level calls here.

/** Everything one JMAP send needs on the wire, frozen to the first attempt. */
export type FrozenSend = {
  from: string;
  to: string;
  toName: string | null;
  cc: CcRecipient[];
  subject: string;
  html: string;
  text: string | undefined;
  headers: Record<string, string>;
  attachments: SendEmailAttachment[];
};

/**
 * Every binary part of a content row (attachments and inline related parts),
 * read from the content-owned R2 copies, in part order. Null when an object is
 * missing, so the caller falls back to the stored outbox fields instead of
 * sending a partial message.
 */
export async function loadContentAttachments(
  env: CloudflareBindings,
  content: JmapContentRow,
): Promise<SendEmailAttachment[] | null> {
  const tree = JSON.parse(content.partsJson);
  const out: SendEmailAttachment[] = [];
  for (const leaf of contentLeaves(tree)) {
    if (!leaf.r2Key) continue;
    const object = await env.R2.get(leaf.r2Key);
    if (!object) {
      console.error(
        `[outbox] missing content object ${leaf.r2Key} for content ${content.id}`,
      );
      return null;
    }
    out.push({
      filename: leaf.name ?? `part-${leaf.partId}`,
      contentType: leaf.type,
      content: await object.arrayBuffer(),
      contentId: leaf.cid,
      disposition: leaf.disposition === "inline" ? "inline" : "attachment",
    });
  }
  return out;
}

/**
 * Rebuild a JMAP send exactly as its first attempt went out (spec §10.1): the
 * content row freezes the To name, Cc, subject, References, cid/disposition and
 * bodies; the intention freezes the From header. Null when either row is gone.
 */
export async function loadFrozenJmapSend(
  db: DrizzleD1Database<any>,
  env: CloudflareBindings,
  sentEmailId: string,
): Promise<FrozenSend | null> {
  const [submission] = await db
    .select()
    .from(jmapSubmissions)
    .where(eq(jmapSubmissions.sentEmailId, sentEmailId))
    .limit(1);
  if (!submission) return null;
  const [content] = await db
    .select()
    .from(jmapMessageContent)
    .where(eq(jmapMessageContent.id, submission.contentId))
    .limit(1);
  if (!content) return null;
  const attachments = await loadContentAttachments(env, content);
  if (attachments === null) return null;
  const message = buildSubmissionMessage(
    content,
    { email: submission.identityEmail, displayName: null },
    attachments,
  );
  return {
    from: submission.fromHeader ?? message.from,
    to: message.to,
    toName: message.toName,
    cc: message.cc,
    subject: message.subject,
    html: message.html,
    text: message.text,
    headers: message.headers,
    attachments: message.attachments,
  };
}
