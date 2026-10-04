import { and, desc, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { asyncJobs, type AsyncJob } from "../../db/async-jobs.schema";
import { inboxConversationState } from "../../db/inbox-conversation-state.schema";
import { bumpJmapEpoch } from "../../jmap/epoch";
import { AUDIT_ACTIONS } from "../audit/events";
import { recordAudit } from "../audit/record";
import { isDemoMode } from "../is-dev";
import {
  IDLE_SECONDS,
  SliceBusyError,
  changesOf,
  claimSlice,
  paramsOf,
  recoverIdleJob,
  releaseClaim,
  stillClaimed,
  type SliceState,
} from "../jobs/slices";
import { notifyMailRefresh } from "../triage/ai-file";
import { queryMessages } from "./query";
import {
  citedIdsOf,
  citedThreadKeySql,
  threadKeyOf,
  type ThreadingMode,
} from "./thread-key";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/** A queued slice of an inbox's thread backfill. */
export type ThreadBackfillMessage = {
  type: "thread_backfill";
  jobId: string;
  slice: number;
};

export interface BackfillParams extends SliceState {
  inbox: string;
  mode: ThreadingMode;
  /** `headers`: the walk (1), then the walk again for late parents (2). */
  pass: 1 | 2;
  /** `queryMessages` cursor of the walk, null at its start. */
  cursor: string | null;
}

export const BACKFILL_LIMITS = {
  /** Messages read per page. */
  pageSize: 200,
  /** Row statements per slice (D1 allows 1,000 queries an invocation). */
  sliceStatements: 400,
  /** Wall time per slice. */
  sliceMs: 20_000,
  /** Rows cleared per statement when going back to `relationship`. */
  clearBatch: 500,
};

/** The newest backfill of an inbox, running or not. */
export async function latestThreadBackfill(
  db: Db,
  inbox: string,
): Promise<AsyncJob | null> {
  const [job] = await db
    .select()
    .from(asyncJobs)
    .where(
      and(eq(asyncJobs.jobType, "thread_backfill"), eq(asyncJobs.refId, inbox)),
    )
    .orderBy(desc(asyncJobs.createdAt), desc(sql`rowid`))
    .limit(1);
  return job ?? null;
}

/**
 * Claims the inbox for a backfill to `mode`: inserts the job unless one is
 * running for it already (then null). Nothing else has changed yet, so a
 * caller that gets null can answer 409.
 */
export async function insertThreadBackfill(
  db: Db,
  input: { inbox: string; mode: ThreadingMode; requestedBy: string | null },
): Promise<AsyncJob | null> {
  const id = nanoid();
  const now = Math.floor(Date.now() / 1000);
  const params: BackfillParams = {
    slice: 0,
    lease: null,
    leaseUntil: null,
    inbox: input.inbox,
    mode: input.mode,
    pass: 1,
    cursor: null,
  };
  const result = await db.run(sql`
    INSERT INTO async_jobs
      (id, job_type, ref_id, status, params, requested_by, processed_rows,
       imported_count, skipped_count, created_at, updated_at)
    SELECT ${id}, 'thread_backfill', ${input.inbox}, 'running',
      ${JSON.stringify(params)}, ${input.requestedBy}, 0, 0, 0, ${now}, ${now}
    WHERE NOT EXISTS (
      SELECT 1 FROM async_jobs
      WHERE job_type = 'thread_backfill' AND ref_id = ${input.inbox}
        AND status = 'running'
    )
  `);
  if (changesOf(result) !== 1) return null;
  const [job] = await db
    .select()
    .from(asyncJobs)
    .where(eq(asyncJobs.id, id))
    .limit(1);
  return job ?? null;
}

/**
 * After the mode is saved: clears the inbox's snoozes and assignments (they
 * were keyed by conversations that no longer exist), counts the work for the
 * progress bar, and starts the job. Returns how many states were cleared.
 */
export async function startThreadBackfill(
  db: Db,
  env: CloudflareBindings,
  job: AsyncJob,
  waitUntil: (promise: Promise<unknown>) => void,
): Promise<number> {
  const { inbox, mode } = paramsOf<BackfillParams>(job);
  const cleared = await db
    .delete(inboxConversationState)
    .where(eq(inboxConversationState.inbox, inbox));
  const [counted] = await db.all<{ total: number }>(
    mode === "headers"
      ? sql`SELECT 2 * (
          (SELECT COUNT(*) FROM emails WHERE recipient = ${inbox}) +
          (SELECT COUNT(*) FROM sent_emails WHERE from_address = ${inbox})
        ) AS total`
      : sql`SELECT
          (SELECT COUNT(*) FROM emails
            WHERE recipient = ${inbox} AND thread_key IS NOT NULL) +
          (SELECT COUNT(*) FROM sent_emails
            WHERE from_address = ${inbox} AND thread_key IS NOT NULL)
        AS total`,
  );
  await db
    .update(asyncJobs)
    .set({ totalRows: counted?.total ?? 0 })
    .where(eq(asyncJobs.id, job.id));
  if (isDemoMode(env)) {
    // No queue consumer: run the slices after the response (the hourly run
    // finishes one that outlives it).
    waitUntil(runThreadBackfillInline(db, env, job.id));
  } else {
    await resumeThreadBackfill(db, env, job.id, 0);
  }
  return changesOf(cleared);
}

/** Queues the slice a backfill is waiting for, or runs it here in demo mode. */
export async function resumeThreadBackfill(
  db: Db,
  env: CloudflareBindings,
  jobId: string,
  slice: number,
): Promise<void> {
  if (isDemoMode(env)) {
    await runThreadBackfillInline(db, env, jobId, slice);
    return;
  }
  const message: ThreadBackfillMessage = {
    type: "thread_backfill",
    jobId,
    slice,
  };
  await env.EMAIL_QUEUE.send(message);
}

/** Runs a backfill's slices one after another (DEMO_MODE). */
export async function runThreadBackfillInline(
  db: Db,
  env: CloudflareBindings,
  jobId: string,
  from = 0,
): Promise<void> {
  let slice: number | null = from;
  try {
    while (slice !== null) {
      slice = await runThreadBackfillSlice(db, env, jobId, slice);
    }
  } catch (error) {
    console.error(`[threads] backfill ${jobId} failed:`, error);
    await failThreadBackfill(
      db,
      jobId,
      error instanceof Error ? error.message : "backfill failed",
    );
  }
}

/**
 * One slice of a backfill: up to `sliceStatements` rows or `sliceMs`,
 * saving progress after every page. Returns the next slice, or null when
 * the job is done (or no longer this run's). Re-running a page is safe: each
 * row's key is computed from the rows around it, not from its own.
 */
export async function runThreadBackfillSlice(
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
  if (!job || job.status !== "running") return null;
  const claim = await claimSlice<BackfillParams>(db, job, slice, now());
  if (claim === "stale") return null;
  if (claim === "busy") throw new SliceBusyError(jobId);
  const { params, raw } = claim;
  let state = { raw, params };
  try {
    const started = now();
    let statements = 0;
    for (;;) {
      const step =
        params.mode === "headers"
          ? await headersPage(db, state.params)
          : await clearPage(db, state.params);
      const next: BackfillParams = { ...state.params, ...step.progress };
      const nextRaw = JSON.stringify(next);
      const saved = await db.batch([
        ...step.statements,
        db
          .update(asyncJobs)
          .set({
            params: nextRaw,
            processedRows: sql`${asyncJobs.processedRows} + ${step.rows}`,
            updatedAt: Math.floor(now() / 1000),
          })
          .where(stillClaimed(job.id, state.raw)),
      ] as any);
      if (changesOf(saved[saved.length - 1]) !== 1) return null;
      state = { raw: nextRaw, params: next };
      if (step.done) {
        await completeThreadBackfill(db, env, job, state.raw);
        return null;
      }
      statements += step.statements.length;
      if (
        statements >= BACKFILL_LIMITS.sliceStatements ||
        now() - started >= BACKFILL_LIMITS.sliceMs
      ) {
        break;
      }
    }
    const released = await db
      .update(asyncJobs)
      .set({
        params: JSON.stringify({
          ...state.params,
          slice: state.params.slice + 1,
          lease: null,
          leaseUntil: null,
        }),
        updatedAt: Math.floor(now() / 1000),
      })
      .where(stillClaimed(job.id, state.raw));
    return changesOf(released) === 1 ? state.params.slice + 1 : null;
  } catch (error) {
    await releaseClaim(db, jobId, state.params, state.raw);
    throw error;
  }
}

type Step = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  statements: any[];
  rows: number;
  progress: Partial<BackfillParams>;
  done: boolean;
};

/**
 * A page of the `headers` walk, oldest first, both directions, every folder.
 * Each row takes the thread of the nearest message it cites that has one;
 * on the first pass a row citing nothing known roots its own thread, on the
 * second it keeps the thread it has. A statement per row, in one batch, so
 * a reply sees the key its parent got earlier in the page.
 */
async function headersPage(db: Db, params: BackfillParams): Promise<Step> {
  const page = await queryMessages(
    db,
    { isAdmin: true },
    {
      inboxes: [params.inbox],
      order: "asc",
      limit: BACKFILL_LIMITS.pageSize,
      ...(params.cursor ? { cursor: params.cursor } : {}),
      ignoreSnooze: true,
    },
  );
  const statements: SQL[] = [];
  const sentIds: string[] = [];
  for (const message of page.messages) {
    const cited = citedIdsOf(message.inReplyTo, message.references ?? null);
    if (params.pass === 2 && cited.length === 0) continue;
    const { kind, id } = message.ref;
    const table = kind === "received" ? sql`emails` : sql`sent_emails`;
    const fallback =
      params.pass === 1
        ? sql`${await threadKeyOf(
            message.messageId?.trim() ? message.messageId : `${kind}:${id}`,
          )}`
        : sql`${table}.thread_key`;
    statements.push(sql`
      UPDATE ${table} SET thread_key = x.k
      FROM (SELECT COALESCE(${citedThreadKeySql(params.inbox, cited)}, ${fallback}) AS k
            FROM ${table} WHERE id = ${id}) AS x
      WHERE ${table}.id = ${id} AND ${table}.thread_key IS NOT x.k
    `);
    if (kind === "sent") sentIds.push(id);
  }
  if (sentIds.length > 0) {
    // A JMAP send's thread is its content's: keep the two the same.
    statements.push(sql`
      UPDATE jmap_message_content
      SET thread_key = (
        SELECT se.thread_key FROM sent_emails se
        WHERE se.jmap_content_id = jmap_message_content.id
          AND se.thread_key IS NOT NULL
        LIMIT 1
      )
      WHERE id IN (
        SELECT jmap_content_id FROM sent_emails
        WHERE id IN (SELECT value FROM json_each(${JSON.stringify(sentIds)}))
          AND jmap_content_id IS NOT NULL AND thread_key IS NOT NULL
      )
    `);
  }
  const walked = page.nextCursor === null;
  return {
    statements: statements.map((statement) => db.run(statement)),
    rows: page.messages.length,
    progress: walked
      ? params.pass === 1
        ? { pass: 2, cursor: null }
        : { cursor: null }
      : { cursor: page.nextCursor },
    done: walked && params.pass === 2,
  };
}

/**
 * Back to `relationship`: clears `thread_key` a batch at a time. A JMAP
 * send's content goes back to the conversation its Sent row is in, as a
 * draft written in a relationship inbox would have.
 */
async function clearPage(db: Db, params: BackfillParams): Promise<Step> {
  const inbox = params.inbox;
  const batch = BACKFILL_LIMITS.clearBatch;
  const [left] = await db.all<{ received: number; sent: number }>(sql`
    SELECT
      (SELECT COUNT(*) FROM (SELECT 1 FROM emails
        WHERE recipient = ${inbox} AND thread_key IS NOT NULL
        LIMIT ${batch})) AS received,
      (SELECT COUNT(*) FROM (SELECT 1 FROM sent_emails
        WHERE from_address = ${inbox} AND thread_key IS NOT NULL
        LIMIT ${batch})) AS sent
  `);
  const received = left?.received ?? 0;
  const sent = left?.sent ?? 0;
  const sentRows = sql`
    SELECT rowid FROM sent_emails
    WHERE from_address = ${inbox} AND thread_key IS NOT NULL
    ORDER BY rowid LIMIT ${batch}
  `;
  const statements: SQL[] = [];
  if (received > 0) {
    statements.push(sql`
      UPDATE emails SET thread_key = NULL
      WHERE rowid IN (
        SELECT rowid FROM emails
        WHERE recipient = ${inbox} AND thread_key IS NOT NULL
        ORDER BY rowid LIMIT ${batch}
      )
    `);
  }
  if (sent > 0) {
    // The same rows in both statements: the batch is one transaction.
    statements.push(
      sql`
        UPDATE jmap_message_content
        SET thread_key = (
          SELECT COALESCE(se.conversation_id, 'p:' || se.person_id, 'sent:' || se.id)
          FROM sent_emails se WHERE se.jmap_content_id = jmap_message_content.id
          LIMIT 1
        )
        WHERE id IN (
          SELECT jmap_content_id FROM sent_emails
          WHERE rowid IN (${sentRows}) AND jmap_content_id IS NOT NULL
        )
      `,
      sql`UPDATE sent_emails SET thread_key = NULL WHERE rowid IN (${sentRows})`,
    );
  }
  return {
    statements: statements.map((statement) => db.run(statement)),
    rows: received + sent,
    progress: {},
    done: received < batch && sent < batch,
  };
}

/**
 * The end of a backfill (or of a failed one): every JMAP client resyncs once,
 * since thread ids changed under the account they hold.
 */
async function finishBackfill(
  db: Db,
  env: CloudflareBindings | null,
  job: AsyncJob,
): Promise<void> {
  await bumpJmapEpoch(db, job.requestedBy);
  if (env) await notifyMailRefresh(db, env, job.refId);
}

async function completeThreadBackfill(
  db: Db,
  env: CloudflareBindings,
  job: AsyncJob,
  claimedRaw: string,
): Promise<void> {
  const params = paramsOf<BackfillParams>(job);
  const result = await db
    .update(asyncJobs)
    .set({
      status: "completed",
      params: JSON.stringify({
        ...JSON.parse(claimedRaw),
        lease: null,
        leaseUntil: null,
      }),
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(stillClaimed(job.id, claimedRaw));
  if (changesOf(result) !== 1) return;
  const [done] = await db
    .select({ processedRows: asyncJobs.processedRows })
    .from(asyncJobs)
    .where(eq(asyncJobs.id, job.id))
    .limit(1);
  await finishBackfill(db, env, job);
  await recordAudit(db, {
    action: AUDIT_ACTIONS.inboxUpdated,
    targetType: "inbox",
    targetId: params.inbox,
    inbox: params.inbox,
    summary:
      params.mode === "headers"
        ? `Grouped the mail of ${params.inbox} into threads`
        : `Grouped the mail of ${params.inbox} by customer`,
    details: {
      threadingMode: params.mode,
      backfill: "completed",
      rows: done?.processedRows ?? 0,
    },
  });
}

/** Ends a backfill that cannot finish; mail stays as far as it got. */
export async function failThreadBackfill(
  db: Db,
  jobId: string,
  reason: string,
): Promise<void> {
  const [job] = await db
    .select()
    .from(asyncJobs)
    .where(eq(asyncJobs.id, jobId))
    .limit(1);
  if (!job || job.status !== "running") return;
  const result = await db
    .update(asyncJobs)
    .set({
      status: "failed",
      errorSummary: JSON.stringify([
        { row: job.processedRows, reason: reason.slice(0, 300) },
      ]),
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(and(eq(asyncJobs.id, jobId), eq(asyncJobs.status, "running")));
  if (changesOf(result) !== 1) return;
  await finishBackfill(db, null, job);
}

/** Hourly: a backfill that stopped moving is queued again (three times). */
export async function reapThreadBackfills(
  db: Db,
  env: CloudflareBindings,
  nowSeconds: number,
): Promise<{ resumed: number; failed: number }> {
  const idle = await db
    .select()
    .from(asyncJobs)
    .where(
      and(
        eq(asyncJobs.jobType, "thread_backfill"),
        eq(asyncJobs.status, "running"),
        lt(asyncJobs.updatedAt, nowSeconds - IDLE_SECONDS),
      ),
    )
    .limit(100);
  let resumed = 0;
  let failed = 0;
  for (const job of idle) {
    const recovery = await recoverIdleJob<BackfillParams>(db, job, nowSeconds);
    if (recovery.action === "fail") {
      await failThreadBackfill(db, job.id, "stalled");
      failed++;
    } else if (recovery.action === "resume") {
      await resumeThreadBackfill(db, env, job.id, recovery.params.slice);
      resumed++;
    }
  }
  return { resumed, failed };
}

/** What the inbox list shows of a backfill. */
export function backfillStatus(job: AsyncJob | null) {
  if (!job) return null;
  const params = paramsOf<BackfillParams>(job);
  return {
    id: job.id,
    mode: params.mode,
    status: job.status as "running" | "completed" | "failed",
    processed: job.processedRows,
    total: job.totalRows ?? 0,
  };
}

/** Running backfills of these inboxes, newest per inbox. */
export async function latestThreadBackfills(
  db: Db,
  inboxes: string[],
): Promise<Map<string, AsyncJob>> {
  const latest = new Map<string, AsyncJob>();
  if (inboxes.length === 0) return latest;
  const rows = await db
    .select()
    .from(asyncJobs)
    .where(
      and(
        eq(asyncJobs.jobType, "thread_backfill"),
        inArray(
          asyncJobs.refId,
          sql`(SELECT value FROM json_each(${JSON.stringify(inboxes)}))`,
        ),
      ),
    )
    .orderBy(desc(asyncJobs.createdAt), desc(sql`rowid`));
  for (const row of rows) {
    if (!latest.has(row.refId)) latest.set(row.refId, row);
  }
  return latest;
}
