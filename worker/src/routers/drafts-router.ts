import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { MAX_CC_ENTRIES } from "../lib/send-limits";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { drafts } from "../db/drafts.schema";
import { upsertDraft } from "../lib/drafts";
import { createEmailSender } from "../lib/email-sender";
import {
  parseSendBody,
  sendParseErrorResponse,
  type SendParseError,
} from "../lib/multipart-send";
import { storeUpload } from "../jmap/upload";
import { publicAccountId } from "../jmap/public-ids";
import {
  type ExtraAttachment,
  sendWebDraft,
  destroyJmapDraftFromWeb,
  destroyLinkedJmapDraft,
  linkedDraftInfo,
  refreshGone,
  type LinkedDraftInfo,
  listJmapOnlyDrafts,
  openJmapDraft,
  publishWebDraft,
} from "../jmap/web-drafts";
import { json200Response } from "../lib/helpers";
import { bearerSecurity } from "../lib/openapi-auth";
import type { Variables } from "../variables";

export const draftsRouter = new OpenAPIHono<{
  Bindings: CloudflareBindings;
  Variables: Variables;
}>();

const CcEntrySchema = z.object({
  email: z.string(),
  name: z.string().nullable().optional(),
});

/** The shape returned to the client — cc parsed back into an array. */
const DraftSchema = z.object({
  id: z.string(),
  contextKey: z.string(),
  fromAddress: z.string().nullable(),
  toAddress: z.string().nullable(),
  cc: z.array(CcEntrySchema).nullable(),
  subject: z.string().nullable(),
  bodyHtml: z.string().nullable(),
  bodyText: z.string().nullable(),
  replyToEmailId: z.string().nullable(),
  updatedAt: z.number(),
  /**
   * Shared drafts: what the draft carries that this composer can't show yet
   * (kept on publish; web Send is off while any remain).
   */
  jmapExtras: z.array(z.string()),
  /** `gone` once the draft was sent or deleted from a JMAP client. */
  jmapState: z.enum(["gone"]).nullable(),
  /** Shared drafts: Bcc recipients, null when there are none yet. */
  bcc: z.array(CcEntrySchema).nullable(),
  /** Attachments the draft carries from its JMAP revision (kept ones only). */
  storedAttachments: z.array(
    z.object({
      partId: z.string(),
      name: z.string().nullable(),
      type: z.string(),
      size: z.number(),
    }),
  ),
  /**
   * The JMAP revision those part ids belong to: send it back as
   * `keptAttachmentsRev` (part ids renumber on each publish).
   */
  storedAttachmentsRev: z.string().nullable(),
});

type DraftRow = typeof drafts.$inferSelect;

function toDraft(
  row: DraftRow,
  linked: LinkedDraftInfo = { extras: [], stored: [], rev: null },
): z.infer<typeof DraftSchema> {
  let bcc: z.infer<typeof CcEntrySchema>[] | null = null;
  if (row.bcc) {
    try {
      const parsed = JSON.parse(row.bcc);
      if (Array.isArray(parsed)) bcc = parsed;
    } catch {
      bcc = null;
    }
  }
  let cc: z.infer<typeof CcEntrySchema>[] | null = null;
  if (row.cc) {
    try {
      const parsed = JSON.parse(row.cc);
      if (Array.isArray(parsed)) cc = parsed;
    } catch {
      cc = null;
    }
  }
  return {
    id: row.id,
    contextKey: row.contextKey,
    fromAddress: row.fromAddress,
    toAddress: row.toAddress,
    cc,
    subject: row.subject,
    bodyHtml: row.bodyHtml,
    bodyText: row.bodyText,
    replyToEmailId: row.replyToEmailId,
    updatedAt: row.updatedAt,
    jmapExtras: linked.extras,
    jmapState: row.jmapState ?? null,
    bcc,
    storedAttachments: linked.stored,
    storedAttachmentsRev: linked.rev,
  };
}

const DraftListItemSchema = z.object({
  id: z.string(),
  contextKey: z.string(),
  fromAddress: z.string().nullable(),
  toAddress: z.string().nullable(),
  subject: z.string().nullable(),
  replyToEmailId: z.string().nullable(),
  updatedAt: z.number(),
});

const DraftListQuery = z.object({
  inbox: z.string().min(1).max(320).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// GET /api/drafts/list — list the current user's drafts newest-first.
const listDraftsRoute = createRoute({
  method: "get",
  path: "/list",
  tags: ["Drafts"],
  security: bearerSecurity,
  description:
    "List the current user's drafts newest-first, optionally scoped to an inbox.",
  request: { query: DraftListQuery },
  responses: {
    ...json200Response(
      z.object({ drafts: z.array(DraftListItemSchema) }),
      "The current user's drafts",
    ),
  },
});

draftsRouter.openapi(listDraftsRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const { inbox, limit, offset } = c.req.valid("query");
  const normalizedInbox = inbox?.trim().toLowerCase();

  const where = normalizedInbox
    ? and(
        eq(drafts.userId, user.id),
        or(eq(drafts.fromAddress, normalizedInbox), isNull(drafts.fromAddress)),
      )
    : eq(drafts.userId, user.id);

  const rows = await db
    .select({
      id: drafts.id,
      contextKey: drafts.contextKey,
      fromAddress: drafts.fromAddress,
      toAddress: drafts.toAddress,
      subject: drafts.subject,
      replyToEmailId: drafts.replyToEmailId,
      updatedAt: drafts.updatedAt,
    })
    .from(drafts)
    .where(where)
    .orderBy(desc(drafts.updatedAt))
    .limit(limit)
    .offset(offset);

  // Shared drafts: drafts made in a JMAP client are listed too (first page).
  const jmapOnly =
    offset === 0
      ? await listJmapOnlyDrafts(
          db,
          c.get("allowedInboxes")!,
          user.id,
          normalizedInbox,
        )
      : [];
  const merged = [...rows, ...jmapOnly]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit);
  return c.json({ drafts: merged }, 200);
});

const ContextQuery = z.object({
  contextKey: z.string().min(1).max(200),
});

// GET /api/drafts?contextKey=… — fetch the draft for a compose surface.
const getDraftRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Drafts"],
  security: bearerSecurity,
  description:
    "Get the current user's autosaved draft for a compose surface (by contextKey), or null.",
  request: { query: ContextQuery },
  responses: {
    ...json200Response(
      z.object({ draft: DraftSchema.nullable() }),
      "The draft, or null if none exists",
    ),
  },
});

draftsRouter.openapi(getDraftRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const { contextKey } = c.req.valid("query");
  const rows = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.userId, user.id), eq(drafts.contextKey, contextKey)))
    .limit(1);
  // A copy whose JMAP draft was sent or deleted elsewhere says so on open.
  const row = rows[0] ? await refreshGone(db, rows[0]) : null;
  return c.json(
    { draft: row ? toDraft(row, await linkedDraftInfo(db, row)) : null },
    200,
  );
});

// PUT /api/drafts — upsert the draft for a compose surface.
const SaveDraftBody = z.object({
  contextKey: z.string().min(1).max(200),
  fromAddress: z.string().max(320).optional(),
  // A draft `to` may be a partial/incomplete address while the user types,
  // so it is deliberately NOT validated as an email here. Several To are
  // comma-separated (up to the 50-recipient limit).
  to: z
    .string()
    .max(50 * 322)
    .optional(),
  cc: z.array(CcEntrySchema).max(MAX_CC_ENTRIES).optional(),
  subject: z.string().max(2000).optional(),
  bodyHtml: z.string().optional(),
  bodyText: z.string().optional(),
  replyToEmailId: z.string().nullable().optional(),
  /** Shared drafts: Bcc recipients (omit to leave them unchanged). */
  bcc: z.array(CcEntrySchema).max(MAX_CC_ENTRIES).optional(),
  /**
   * Shared drafts: part ids of the stored attachments to keep (from
   * `storedAttachments`); omit to leave the choice unchanged.
   */
  keptAttachments: z.array(z.string().max(20)).max(64).optional(),
  /** The `storedAttachmentsRev` the kept list was chosen on. */
  keptAttachmentsRev: z.string().max(64).nullable().optional(),
  /**
   * Start a new draft: unlink from the mail-client draft (which stays where it
   * is) and clear a gone state. A composer that didn't restore this surface's
   * draft sends it on its first save; so does "keep as a new draft".
   */
  fresh: z.boolean().optional(),
});

/** A send also carries the signature, added to the sent revision only. */
const SendDraftBody = SaveDraftBody.extend({
  signatureHtml: z.string().max(100_000).optional(),
});

const saveDraftRoute = createRoute({
  method: "put",
  path: "/",
  tags: ["Drafts"],
  security: bearerSecurity,
  description:
    "Create or update (upsert) the autosaved draft for a compose surface.",
  request: {
    body: {
      content: { "application/json": { schema: SaveDraftBody } },
    },
  },
  responses: {
    ...json200Response(z.object({ draft: DraftSchema }), "The saved draft"),
  },
});

draftsRouter.openapi(saveDraftRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const body = c.req.valid("json");
  const draft = await upsertDraft(db, user.id, body);
  return c.json(
    { draft: toDraft(draft, await linkedDraftInfo(db, draft)) },
    200,
  );
});

// DELETE /api/drafts?contextKey=… — discard a draft (on send or clear).
const deleteDraftRoute = createRoute({
  method: "delete",
  path: "/",
  tags: ["Drafts"],
  security: bearerSecurity,
  description: "Delete the current user's draft for a compose surface.",
  request: { query: ContextQuery },
  responses: {
    ...json200Response(z.object({ success: z.boolean() }), "Draft deleted"),
  },
});

draftsRouter.openapi(deleteDraftRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const { contextKey } = c.req.valid("query");
  const deleted = await db
    .delete(drafts)
    .where(and(eq(drafts.userId, user.id), eq(drafts.contextKey, contextKey)))
    .returning({ jmapDraftId: drafts.jmapDraftId, userId: drafts.userId });
  // A shared draft is one draft: deleting it here deletes it in JMAP too.
  for (const row of deleted) {
    await destroyLinkedJmapDraft(db, c.env, row);
  }
  // A JMAP draft listed in the web with no working copy yet.
  if (deleted.length === 0 && contextKey.startsWith("jmap:")) {
    await destroyJmapDraftFromWeb(
      db,
      c.env,
      c.get("allowedInboxes")!,
      user.id,
      contextKey.slice("jmap:".length),
    );
  }
  return c.json({ success: true }, 200);
});

// POST /api/drafts/open-jmap — open a JMAP draft in the web composer.
const openJmapRoute = createRoute({
  method: "post",
  path: "/open-jmap",
  tags: ["Drafts"],
  security: bearerSecurity,
  description:
    "Open a draft made in a JMAP client (listed with contextKey `jmap:<id>`) in the web composer: creates the working copy the composer edits, and returns its contextKey.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ contextKey: z.string().min(6).max(200) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "The working copy's context key",
      content: {
        "application/json": {
          schema: z.object({ contextKey: z.string() }),
        },
      },
    },
    404: { description: "No such draft" },
    409: { description: "A body the web composer can't edit whole" },
  },
});

draftsRouter.openapi(openJmapRoute, async (c) => {
  const { contextKey } = c.req.valid("json");
  if (!contextKey.startsWith("jmap:")) {
    return c.json({ error: "Not found" }, 404);
  }
  const opened = await openJmapDraft(
    c.get("db"),
    c.get("allowedInboxes")!,
    c.get("user").id,
    contextKey.slice("jmap:".length),
  );
  if (opened.error === "multipart") {
    return c.json(
      {
        error:
          "This draft's text is split into several parts (with images between them); edit it in your mail client.",
      },
      409,
    );
  }
  if (!opened.contextKey) return c.json({ error: "Not found" }, 404);
  return c.json({ contextKey: opened.contextKey }, 200);
});

// POST /api/drafts/send — send a draft through the JMAP submission path.
const sendDraftRoute = createRoute({
  method: "post",
  path: "/send",
  tags: ["Drafts"],
  security: bearerSecurity,
  description:
    "Send the composer's draft the way a JMAP client does: its final values and any new files become the draft's last revision, which is submitted and filed into Sent under the same JMAP Email id. multipart/form-data with a JSON `payload` (the draft fields, as PUT /api/drafts, with the final body) and zero or more `files`. A 409 with `fallback: true` means this inbox can't send through JMAP (no sender identity); use POST /api/send instead.",
  request: {
    body: {
      content: {
        "multipart/form-data": {
          schema: z.object({
            payload: z.string().openapi({
              description: "JSON: the draft fields (see PUT /api/drafts)",
            }),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Sent (or queued for retry by the outbox)",
      content: {
        "application/json": {
          schema: z.object({
            status: z.literal("sent"),
            submissionId: z.string(),
          }),
        },
      },
    },
    400: { description: "The draft can't be sent as it is" },
    409: {
      description:
        "Sent or deleted from a mail client, or `fallback: true`: this inbox can't send through JMAP",
    },
    413: { description: "Attachments too large" },
    422: { description: "The provider or the submission rules refused it" },
  },
});

draftsRouter.openapi(sendDraftRoute, async (c) => {
  const db = c.get("db");
  const user = c.get("user");
  const allowed = c.get("allowedInboxes")!;
  const sender = createEmailSender(c.env);
  const parsed = await parseSendBody(
    c,
    SendDraftBody,
    sender.maxAttachmentBytes(),
  );
  // Worker strict mode is off, so the union doesn't narrow on `ok`.
  if (!parsed.ok) {
    const { status, body } = sendParseErrorResponse(
      (parsed as { err: SendParseError }).err,
    );
    return c.json(body, status);
  }
  const { payload, files } = parsed.value;
  const { signatureHtml, ...fields } = payload;
  await upsertDraft(db, user.id, fields);
  const extraAttachments: ExtraAttachment[] = [];
  for (const file of files) {
    const stored = await storeUpload(db, c.env, {
      userId: user.id,
      accountId: publicAccountId(user.id),
      contentType: file.contentType,
      declaredLength: file.size,
      // Uint8Array is not a BodyInit in the Workers types.
      body: new Response(file.bytes as BodyInit).body,
      maxBytes: sender.maxAttachmentBytes(),
    });
    if (!stored.blob) {
      return c.json({ error: "Attachments too large" }, 413);
    }
    extraAttachments.push({
      blobId: stored.blob.blobId,
      type: stored.blob.type,
      name: file.filename,
    });
  }
  const outcome = await sendWebDraft(
    db,
    c.env,
    allowed,
    user,
    fields.contextKey,
    extraAttachments,
    undefined,
    signatureHtml ? `<div data-signature>${signatureHtml}</div>` : null,
  );
  if (outcome.status === "sent") {
    return c.json(
      { status: "sent" as const, submissionId: outcome.submissionId! },
      200,
    );
  }
  if (outcome.status === "fallback") {
    return c.json({ error: outcome.reason, fallback: true }, 409);
  }
  // Not sent: the draft as it is now (new files may be part of it), so the
  // composer shows them as stored and doesn't attach them again.
  const [row] = await db
    .select()
    .from(drafts)
    .where(
      and(eq(drafts.userId, user.id), eq(drafts.contextKey, fields.contextKey)),
    )
    .limit(1);
  const draft = row ? toDraft(row, await linkedDraftInfo(db, row)) : null;
  const status =
    outcome.status === "invalid"
      ? 400
      : outcome.status === "busy" || outcome.status === "gone"
        ? 409
        : 422;
  return c.json(
    {
      error: friendlyReason(outcome.reason),
      draft,
      // The new files are in the draft now (the revision was published and
      // only the submission refused): the composer shows them as stored.
      filesStored: outcome.status === "refused" && extraAttachments.length > 0,
      ...(outcome.status === "gone" ? { gone: true } : {}),
    },
    status,
  );
});

// POST /api/drafts/publish — publish a compose surface's draft to JMAP.
const PublishResponse = z.object({
  status: z.enum(["published", "unchanged", "skipped", "gone", "notFound"]),
  reason: z.string().optional(),
  draft: DraftSchema.nullable(),
});

/** Publish reasons, as a person reads them. */
function friendlyReason(reason: string | null): string {
  if (!reason) return "The message wasn't sent";
  if (reason.startsWith("invalid to")) return "Check the To addresses";
  if (reason.startsWith("invalid cc")) return "Check the Cc addresses";
  if (reason.startsWith("invalid bcc")) return "Check the Bcc addresses";
  if (reason.startsWith("invalid subject")) return "The subject is too long";
  if (reason.startsWith("invalid tooLarge") || reason === "tooLarge") {
    return "The attachments are too large";
  }
  if (reason.startsWith("invalid")) return "This draft can't be sent as it is";
  return reason;
}

const publishDraftRoute = createRoute({
  method: "post",
  path: "/publish",
  tags: ["Drafts"],
  security: bearerSecurity,
  description:
    "Publish the draft of a compose surface so JMAP clients see it (a new JMAP draft revision when it changed). The composer calls it when it closes and after a minute idle. `gone` means the draft was sent or deleted from a JMAP client.",
  request: {
    body: {
      content: {
        "application/json": {
          schema: z.object({ contextKey: z.string().min(1).max(200) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "What the publish did",
      content: { "application/json": { schema: PublishResponse } },
    },
    401: { description: "Not signed in" },
  },
});

draftsRouter.openapi(publishDraftRoute, async (c) => {
  const { contextKey } = c.req.valid("json");
  const db = c.get("db");
  const userId = c.get("user").id;
  const outcome = await publishWebDraft(
    db,
    c.env,
    c.get("allowedInboxes")!,
    userId,
    contextKey,
  );
  // The draft after the publish: part ids renumber, so the composer refreshes
  // its stored attachments from here.
  const [row] = await db
    .select()
    .from(drafts)
    .where(and(eq(drafts.userId, userId), eq(drafts.contextKey, contextKey)))
    .limit(1);
  return c.json(
    {
      status: outcome.status,
      ...(outcome.status === "skipped" ? { reason: outcome.reason } : {}),
      draft: row ? toDraft(row, await linkedDraftInfo(db, row)) : null,
    },
    200,
  );
});
