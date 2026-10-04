import { and, eq, isNull, lt, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { asyncJobs, type AsyncJob } from "../../db/async-jobs.schema";
import { mailboxes } from "../../db/mailboxes.schema";
import { AUDIT_ACTIONS } from "../audit/events";
import { recordAudit } from "../audit/record";
import { jsonList } from "../inbox-permissions";
import { queryMessages } from "../messages/query";
import type { UnifiedMessage } from "../messages/types";
import { mboxEntry, renderMessageBytes } from "./render-message";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/** A queued slice of a mailbox export: the slice the job is waiting for. */
export type MailExportMessage = {
  type: "mail_export";
  jobId: string;
  slice: number;
};

/** What a person asked to export. */
export interface MailExportRequest {
  inbox: string;
  /** Unix seconds; inclusive bounds on the message date. */
  from?: number | null;
  to?: number | null;
  includeTrash?: boolean;
  includeCampaignSends?: boolean;
}

/** The job's `params`: the request, and where the upload is. */
export interface ExportParams {
  inbox: string;
  from: number | null;
  to: number | null;
  includeTrash: boolean;
  includeCampaignSends: boolean;
  uploadId: string;
  /** The slice that runs next; a queued message for another is stale. */
  slice: number;
  /** Uploaded parts, each exactly PART_BYTES. */
  parts: { partNumber: number; etag: string }[];
  /** Bytes carried to the next slice, less than a part. */
  pendingKey: string | null;
  /** Bytes written so far (uploaded and carried); the file's size at the end. */
  bytes: number;
  /** Every message is rendered; only the last part and completion are left. */
  finishing: boolean;
  /** The run holding the slice now, and until when (Unix ms). */
  lease: string | null;
  leaseUntil: number | null;
}

/** Limits of one slice. Slices stop between pages. */
const SLICE_MESSAGES = 200;
const SLICE_BYTES = 8 * 1024 * 1024;
const SLICE_MS = 20_000;
const PAGE_SIZE = 50;
/** Every part but the last is this size; R2 wants at least 5 MiB. */
export const PART_BYTES = 5 * 1024 * 1024;
/** Long enough for a slice; a crashed run frees its claim after this. */
const LEASE_MS = 120_000;
/** How long a finished export can be downloaded. */
export const EXPORT_TTL_SECONDS = 7 * 24 * 60 * 60;
/** A running export not touched for this long has died. */
const STALE_SECONDS = 24 * 60 * 60;

const objectKey = (jobId: string, inbox: string) =>
  `exports/${jobId}/${inbox}.mbox`;

export class ExportRunningError extends Error {
  readonly code = "EXPORT_RUNNING";
  constructor() {
    super("An export of this inbox is already running");
  }
}

/** Another delivery of this slice holds the claim; try again later. */
export class ExportSliceBusyError extends Error {
  constructor(jobId: string) {
    super(`export ${jobId}: the slice is claimed by another run`);
    this.name = "ExportSliceBusyError";
  }
}

export function exportParams(job: AsyncJob): ExportParams {
  return JSON.parse(job.params ?? "{}") as ExportParams;
}

const changesOf = (result: unknown) =>
  Number((result as D1Result).meta?.changes ?? 0);

/**
 * Starts exporting an inbox: the job row and the R2 multipart upload. The
 * caller queues slice 0 (or runs the slices inline where there is no
 * queue). One running export per inbox.
 */
export async function startMailExport(
  db: Db,
  env: CloudflareBindings,
  input: MailExportRequest & { userId: string },
): Promise<AsyncJob> {
  const inbox = input.inbox.trim().toLowerCase();
  const [running] = await db
    .select({ id: asyncJobs.id })
    .from(asyncJobs)
    .where(
      and(
        eq(asyncJobs.jobType, "mail_export"),
        eq(asyncJobs.refId, inbox),
        eq(asyncJobs.status, "running"),
      ),
    )
    .limit(1);
  if (running) throw new ExportRunningError();

  const id = nanoid();
  const key = objectKey(id, inbox);
  const upload = await env.R2.createMultipartUpload(key, {
    httpMetadata: { contentType: "application/mbox" },
  });
  const now = Math.floor(Date.now() / 1000);
  const params: ExportParams = {
    inbox,
    from: input.from ?? null,
    to: input.to ?? null,
    includeTrash: input.includeTrash === true,
    includeCampaignSends: input.includeCampaignSends === true,
    uploadId: upload.uploadId,
    slice: 0,
    parts: [],
    pendingKey: null,
    bytes: 0,
    finishing: false,
    lease: null,
    leaseUntil: null,
  };
  const job: AsyncJob = {
    id,
    jobType: "mail_export",
    refId: inbox,
    status: "running",
    cursor: null,
    storageKey: key,
    totalRows: null,
    processedRows: 0,
    importedCount: 0,
    skippedCount: 0,
    errorSummary: null,
    params: JSON.stringify(params),
    requestedBy: input.userId,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(asyncJobs).values(job);
  await recordAudit(db, {
    action: AUDIT_ACTIONS.exportStarted,
    targetType: "export",
    targetId: id,
    inbox,
    summary: `Started exporting ${inbox}`,
    details: {
      from: params.from,
      to: params.to,
      includeTrash: params.includeTrash,
      includeCampaignSends: params.includeCampaignSends,
    },
  });
  return job;
}

/**
 * Fills parts of exactly PART_BYTES and uploads each as soon as it is full,
 * so a slice holds one part and one message at a time.
 */
class PartWriter {
  private buffer = new Uint8Array(PART_BYTES);
  private length = 0;

  constructor(
    private upload: R2MultipartUpload,
    readonly parts: { partNumber: number; etag: string }[],
  ) {}

  async write(bytes: Uint8Array): Promise<void> {
    let offset = 0;
    while (offset < bytes.length) {
      const take = Math.min(PART_BYTES - this.length, bytes.length - offset);
      this.buffer.set(bytes.subarray(offset, offset + take), this.length);
      this.length += take;
      offset += take;
      if (this.length === PART_BYTES) {
        const part = await this.upload.uploadPart(
          this.parts.length + 1,
          this.buffer,
        );
        this.parts.push({ partNumber: part.partNumber, etag: part.etag });
        this.length = 0;
      }
    }
  }

  /** What did not fill a part. */
  rest(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }
}

const encoder = new TextEncoder();

/** A label as header text: quoted when it has a comma, RFC 2047 if not ASCII. */
function labelText(name: string): string {
  if (/^[\x20-\x7e]*$/.test(name)) {
    return /[,"\\]/.test(name) ? `"${name.replace(/["\\]/g, "\\$&")}"` : name;
  }
  let binary = "";
  for (const byte of encoder.encode(name)) binary += String.fromCharCode(byte);
  return `=?UTF-8?B?${btoa(binary)}?=`;
}

/**
 * What saasmail knows about a message beyond its bytes, as headers an import
 * can read back (other clients ignore them). Labels follow Gmail's
 * `X-Gmail-Labels`: the system folder (none for archived mail), Starred,
 * then custom folders. Seen and Starred are the requester's.
 */
export function statusHeaders(
  message: UnifiedMessage,
  folderNames: Map<string, string>,
): string[] {
  const state = message.state;
  const labels: string[] = [];
  if (message.direction === "outbound") labels.push("Sent");
  if (state?.trashedAt) labels.push("Trash");
  else if (state?.spamAt) labels.push("Junk");
  else if (!state?.archivedAt && message.direction === "inbound") {
    labels.push("Inbox");
  }
  if (state?.starredAt) labels.push("Starred");
  for (const id of state?.mailboxIds ?? []) {
    const name = folderNames.get(id);
    if (name) labels.push(labelText(name));
  }
  const headers = [`X-Saasmail-Labels: ${labels.join(", ")}`];
  if (message.direction === "inbound") {
    headers.push(`X-Saasmail-Seen: ${state?.seen ? "yes" : "no"}`);
  }
  if (message.personId) headers.push(`X-Saasmail-Person: ${message.personId}`);
  if (state?.conversationKey && /^[\x21-\x7e]+$/.test(state.conversationKey)) {
    headers.push(`X-Saasmail-Conversation: ${state.conversationKey}`);
  }
  return headers;
}

async function customFolderNames(
  db: Db,
  messages: UnifiedMessage[],
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(messages.flatMap((message) => message.state?.mailboxIds ?? [])),
  ];
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: mailboxes.id, name: mailboxes.name })
    .from(mailboxes)
    .where(
      and(sql`${mailboxes.id} IN ${jsonList(ids)}`, isNull(mailboxes.role)),
    );
  return new Map(rows.map((row) => [row.id, row.name]));
}

/**
 * Claims the slice for this run, or says why not: `stale` when the job has
 * moved past it (a duplicate or old delivery), `busy` while another run of
 * it holds the claim.
 */
async function claimSlice(
  db: Db,
  job: AsyncJob,
  slice: number,
  nowMs: number,
): Promise<{ params: ExportParams; raw: string } | "stale" | "busy"> {
  const params = exportParams(job);
  if (params.slice !== slice) return "stale";
  if (params.lease && (params.leaseUntil ?? 0) > nowMs) return "busy";
  const claimed: ExportParams = {
    ...params,
    lease: nanoid(),
    leaseUntil: nowMs + LEASE_MS,
  };
  const raw = JSON.stringify(claimed);
  const result = await db
    .update(asyncJobs)
    .set({ params: raw, updatedAt: Math.floor(nowMs / 1000) })
    .where(
      and(
        eq(asyncJobs.id, job.id),
        eq(asyncJobs.status, "running"),
        eq(asyncJobs.params, job.params ?? ""),
      ),
    );
  return changesOf(result) === 1 ? { params: claimed, raw } : "busy";
}

/**
 * One slice of an export. Renders the next messages (at most 200, about
 * 8 MiB, or 20 seconds' worth) as mbox entries after what the last slice
 * carried over, uploads every whole part, and carries the rest. Returns the
 * next slice to queue, or null when there is none.
 *
 * Safe to run twice: a delivery for a slice the job has moved past does
 * nothing, two deliveries of one slice cannot both claim it, and a retry
 * after a failure re-uploads the same part numbers with the same bytes
 * (rendering is deterministic).
 */
export async function runMailExportSlice(
  db: Db,
  env: CloudflareBindings,
  jobId: string,
  slice: number,
  now: () => number = Date.now,
): Promise<number | null> {
  const [job] = await db
    .select()
    .from(asyncJobs)
    .where(eq(asyncJobs.id, jobId))
    .limit(1);
  if (!job || job.jobType !== "mail_export" || job.status !== "running") {
    return null;
  }
  const claim = await claimSlice(db, job, slice, now());
  if (claim === "stale") return null;
  if (claim === "busy") throw new ExportSliceBusyError(jobId);
  const { params, raw } = claim;

  try {
    if (params.finishing) {
      await completeExport(db, env, job, params, raw);
      return null;
    }
    return await renderSlice(db, env, job, params, raw, now);
  } catch (error) {
    // Free the claim so the retry can run at once.
    await db
      .update(asyncJobs)
      .set({
        params: JSON.stringify({ ...params, lease: null, leaseUntil: null }),
      })
      .where(and(eq(asyncJobs.id, jobId), eq(asyncJobs.params, raw)))
      .catch(() => {});
    throw error;
  }
}

async function renderSlice(
  db: Db,
  env: CloudflareBindings,
  job: AsyncJob,
  params: ExportParams,
  claimedRaw: string,
  now: () => number,
): Promise<number | null> {
  const started = now();
  const writer = new PartWriter(
    env.R2.resumeMultipartUpload(job.storageKey!, params.uploadId),
    [...params.parts],
  );
  if (params.pendingKey) {
    const pending = await env.R2.get(params.pendingKey);
    if (!pending) throw new Error(`export ${job.id}: carried bytes missing`);
    await writer.write(new Uint8Array(await pending.arrayBuffer()));
  }

  // Oldest first, every folder; Trash and campaign sends only when asked.
  // Each entry goes into the current part as it is rendered.
  const scope = { isAdmin: false as const, inboxes: [params.inbox] };
  let cursor = job.cursor;
  let processed = 0;
  let written = 0;
  let more = true;
  while (
    processed < SLICE_MESSAGES &&
    written < SLICE_BYTES &&
    now() - started < SLICE_MS
  ) {
    const page = await queryMessages(db, scope, {
      inboxes: [params.inbox],
      order: "asc",
      limit: Math.min(PAGE_SIZE, SLICE_MESSAGES - processed),
      ...(cursor ? { cursor } : {}),
      ...(params.from !== null ? { after: params.from } : {}),
      ...(params.to !== null ? { before: params.to } : {}),
      ignoreSnooze: true,
      includeTrashed: params.includeTrash,
      excludeCampaignSends: !params.includeCampaignSends,
      withAttachments: true,
      withState: true,
      ...(job.requestedBy ? { viewer: { userId: job.requestedBy } } : {}),
    });
    const names = await customFolderNames(db, page.messages);
    for (const message of page.messages) {
      const entry = mboxEntry(
        await renderMessageBytes(db, env, message),
        statusHeaders(message, names),
      );
      await writer.write(entry);
      written += entry.length;
      processed++;
    }
    if (!page.hasMore || !page.nextCursor) {
      more = false;
      break;
    }
    cursor = page.nextCursor;
  }

  // What did not fill a part waits for the next slice; after the last
  // slice it is the last part.
  const rest = writer.rest();
  let pendingKey: string | null = null;
  if (rest.length > 0) {
    pendingKey = `exports/${job.id}/pending-${nanoid()}`;
    await env.R2.put(pendingKey, rest);
  }

  const next: ExportParams = {
    ...params,
    slice: params.slice + 1,
    parts: writer.parts,
    pendingKey,
    bytes: params.bytes + written,
    finishing: !more,
    lease: null,
    leaseUntil: null,
  };
  const result = await db
    .update(asyncJobs)
    .set({
      cursor,
      processedRows: job.processedRows + processed,
      params: JSON.stringify(next),
      updatedAt: Math.floor(now() / 1000),
    })
    .where(and(eq(asyncJobs.id, job.id), eq(asyncJobs.params, claimedRaw)));
  if (changesOf(result) !== 1) {
    // Cancelled meanwhile: leave nothing behind.
    if (pendingKey) await env.R2.delete(pendingKey);
    return null;
  }
  if (params.pendingKey) await env.R2.delete(params.pendingKey);
  return next.slice;
}

/**
 * The last part and completion. A retry after `complete` succeeded finds
 * the object and only marks the job done.
 */
async function completeExport(
  db: Db,
  env: CloudflareBindings,
  job: AsyncJob,
  params: ExportParams,
  claimedRaw: string,
): Promise<void> {
  const key = job.storageKey!;
  let size: number;
  const existing = await env.R2.head(key);
  if (existing) {
    size = existing.size;
  } else {
    const pending = params.pendingKey
      ? await env.R2.get(params.pendingKey)
      : null;
    if (params.pendingKey && !pending) {
      throw new Error(`export ${job.id}: carried bytes missing`);
    }
    const last = pending
      ? new Uint8Array(await pending.arrayBuffer())
      : new Uint8Array(0);
    const upload = env.R2.resumeMultipartUpload(key, params.uploadId);
    if (params.parts.length === 0) {
      // Smaller than a part: one put, and the upload is not needed.
      const object = await env.R2.put(key, last, {
        httpMetadata: { contentType: "application/mbox" },
      });
      size = object?.size ?? last.length;
      await upload.abort().catch(() => {});
    } else {
      const parts = [...params.parts];
      if (last.length > 0) {
        const part = await upload.uploadPart(parts.length + 1, last);
        parts.push({ partNumber: part.partNumber, etag: part.etag });
      }
      size = (await upload.complete(parts)).size;
    }
  }

  const done: ExportParams = {
    ...params,
    pendingKey: null,
    bytes: size,
    lease: null,
    leaseUntil: null,
  };
  const result = await db
    .update(asyncJobs)
    .set({
      status: "completed",
      totalRows: job.processedRows,
      params: JSON.stringify(done),
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(and(eq(asyncJobs.id, job.id), eq(asyncJobs.params, claimedRaw)));
  if (changesOf(result) !== 1) {
    // Cancelled while completing.
    await env.R2.delete(key);
    return;
  }
  if (params.pendingKey) await env.R2.delete(params.pendingKey);
  const total = job.processedRows;
  await recordAudit(db, {
    action: AUDIT_ACTIONS.exportCompleted,
    targetType: "export",
    targetId: job.id,
    inbox: params.inbox,
    summary: `Exported ${total} ${total === 1 ? "message" : "messages"} from ${params.inbox}`,
    details: { messages: total, bytes: size },
  });
  await notifyExportReady(env, job, params.inbox);
}

/** Ends an export that cannot finish, and gives its upload back. */
export async function failMailExport(
  db: Db,
  env: CloudflareBindings,
  jobId: string,
  reason: string,
): Promise<void> {
  const [job] = await db
    .select()
    .from(asyncJobs)
    .where(eq(asyncJobs.id, jobId))
    .limit(1);
  if (!job || job.status !== "running") return;
  await discardUpload(env, job);
  await db
    .update(asyncJobs)
    .set({
      status: "failed",
      errorSummary: JSON.stringify([
        { row: job.processedRows, reason: reason.slice(0, 500) },
      ]),
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(and(eq(asyncJobs.id, jobId), eq(asyncJobs.status, "running")));
}

/** Aborts a running export's upload and drops its carried bytes. */
async function discardUpload(env: CloudflareBindings, job: AsyncJob) {
  const params = exportParams(job);
  try {
    await env.R2.resumeMultipartUpload(
      job.storageKey!,
      params.uploadId,
    ).abort();
  } catch (error) {
    console.warn(`[export] upload of ${job.id} not aborted:`, error);
  }
  if (params.pendingKey) {
    await env.R2.delete(params.pendingKey).catch(() => {});
  }
}

/** Cancels a running export, or deletes a finished one and its file. */
export async function deleteMailExport(
  db: Db,
  env: CloudflareBindings,
  job: AsyncJob,
): Promise<void> {
  await db.delete(asyncJobs).where(eq(asyncJobs.id, job.id));
  if (job.status === "running") await discardUpload(env, job);
  // Everything under the export's prefix: the file, and bytes a slice that
  // was running meanwhile may have carried.
  const prefix = `exports/${job.id}/`;
  let cursor: string | undefined;
  do {
    const listed = await env.R2.list({ prefix, cursor, limit: 100 });
    if (listed.objects.length > 0) {
      await env.R2.delete(listed.objects.map((object) => object.key));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

/**
 * Hourly: a finished export's file goes after 7 days (the row stays,
 * `expired`), and an export that stopped moving for a day has failed.
 */
export async function reapMailExports(
  db: Db,
  env: CloudflareBindings,
  nowSeconds: number,
): Promise<{ expired: number; failed: number }> {
  const finished = await db
    .select()
    .from(asyncJobs)
    .where(
      and(
        eq(asyncJobs.jobType, "mail_export"),
        eq(asyncJobs.status, "completed"),
        lt(asyncJobs.updatedAt, nowSeconds - EXPORT_TTL_SECONDS),
      ),
    )
    .limit(100);
  for (const job of finished) {
    if (job.storageKey) await env.R2.delete(job.storageKey);
    await db
      .update(asyncJobs)
      .set({ status: "expired", updatedAt: nowSeconds })
      .where(and(eq(asyncJobs.id, job.id), eq(asyncJobs.status, "completed")));
  }
  const stale = await db
    .select({ id: asyncJobs.id })
    .from(asyncJobs)
    .where(
      and(
        eq(asyncJobs.jobType, "mail_export"),
        eq(asyncJobs.status, "running"),
        lt(asyncJobs.updatedAt, nowSeconds - STALE_SECONDS),
      ),
    )
    .limit(100);
  for (const job of stale) {
    await failMailExport(db, env, job.id, "stalled");
  }
  return { expired: finished.length, failed: stale.length };
}

/**
 * Runs an export's slices one after another, for deployments without a
 * queue consumer (DEMO_MODE). The first error fails the export.
 */
export async function runMailExportInline(
  db: Db,
  env: CloudflareBindings,
  jobId: string,
): Promise<void> {
  let slice: number | null = 0;
  try {
    while (slice !== null) {
      slice = await runMailExportSlice(db, env, jobId, slice);
    }
  } catch (error) {
    console.error(`[export] ${jobId} failed:`, error);
    await failMailExport(
      db,
      env,
      jobId,
      error instanceof Error ? error.message : "export failed",
    );
  }
}

/** Tells the requester the export is ready: open tabs and Web Push. */
async function notifyExportReady(
  env: CloudflareBindings,
  job: AsyncJob,
  inbox: string,
): Promise<void> {
  if (!job.requestedBy) return;
  try {
    await env.NOTIFICATIONS_HUB.get(
      env.NOTIFICATIONS_HUB.idFromName(job.requestedBy),
    ).fetch(
      new Request("http://do/realtime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "export_ready", inbox, jobId: job.id }),
      }),
    );
  } catch (error) {
    console.warn("[export] ready notice not sent:", error);
  }
}
