import { AUDIT_ACTIONS } from "./audit/events";
import { recordAudit } from "./audit/record";
import { eq, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { appSettings } from "../db/app-settings.schema";

const WEBHOOK_KEY = "webhook";

/** Every event the webhook can send (docs/webhooks.md). */
export const WEBHOOK_EVENTS = [
  "message.received",
  "message.sent",
  "message.bounced",
  "message.complained",
  "message.failed",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
/** The events about mail sent from here: queued, retried and logged. */
export type OutboundWebhookEvent = Exclude<WebhookEvent, "message.received">;

/** A config saved before the event list existed sends only this. */
const DEFAULT_EVENTS: WebhookEvent[] = ["message.received"];

/** Final failures in a row that pause the outbound events. */
export const AUTO_DISABLE_AFTER = 20;

export interface WebhookConfig {
  url: string;
  secret: string | null;
  events: WebhookEvent[];
  /** Goes up on every save and re-enable; a delivery of another one is cancelled. */
  generation: number;
  enabledAt: number | null;
  /** Set when the outbound events were paused after repeated failures. */
  disabledAt: number | null;
  disabledReason: string | null;
}

/** What an admin saves: the rest of the config is managed here. */
export interface WebhookConfigInput {
  url: string;
  secret: string | null;
  /** Omitted: keep the current list. */
  events?: WebhookEvent[];
}

function parseEvents(value: unknown): WebhookEvent[] {
  if (!Array.isArray(value)) return [...DEFAULT_EVENTS];
  // Unknown names drop out; the order is always the list's.
  return WEBHOOK_EVENTS.filter((event) => value.includes(event));
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Whether the config sends this event. A paused config still sends
 * `message.received`, which never counts toward the pause.
 */
export function webhookWants(
  config: WebhookConfig | null,
  event: WebhookEvent,
): boolean {
  if (!config || !config.events.includes(event)) return false;
  return event === "message.received" || config.disabledAt === null;
}

/** Read the single global webhook config. null = unconfigured/disabled/malformed. */
export async function getWebhookConfig(
  db: DrizzleD1Database<any>,
): Promise<WebhookConfig | null> {
  const rows = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, WEBHOOK_KEY))
    .limit(1);
  const raw = rows[0]?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const url = typeof parsed.url === "string" ? parsed.url.trim() : "";
    if (!url) return null;
    const secret =
      typeof parsed.secret === "string" && parsed.secret.length > 0
        ? parsed.secret
        : null;
    const generation = numberOrNull(parsed.generation);
    return {
      url,
      secret,
      events: parseEvents(parsed.events),
      generation: generation !== null && generation >= 0 ? generation : 0,
      enabledAt: numberOrNull(parsed.enabledAt),
      disabledAt: numberOrNull(parsed.disabledAt),
      disabledReason:
        typeof parsed.disabledReason === "string"
          ? parsed.disabledReason
          : null,
    };
  } catch {
    return null;
  }
}

/**
 * Where a URL points, for the audit log: scheme, host and path. A username,
 * a password, the query and the fragment can each hold a token.
 */
function loggableUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "(unparseable URL)";
  }
}

/**
 * The next config generation, as SQL: above the stored one and above every
 * logged delivery's, so a config cleared and saved again never reuses the
 * generation of a delivery still pending.
 */
const NEXT_GENERATION = sql`(MAX(
  COALESCE((SELECT CASE WHEN json_valid(value) THEN json_extract(value, '$.generation') END
              FROM app_settings WHERE key = ${WEBHOOK_KEY}), 0),
  COALESCE((SELECT MAX(generation) FROM webhook_deliveries), 0)
) + 1)`;

/**
 * Write the global webhook config. Pass null (or a blank url) to clear/disable.
 * A save starts a new generation and lifts a pause.
 */
export async function setWebhookConfig(
  db: DrizzleD1Database<any>,
  cfg: WebhookConfigInput | null,
  updatedBy: string | null,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const url = cfg?.url.trim() ?? "";
  const events = url
    ? (cfg?.events ?? (await getWebhookConfig(db))?.events ?? DEFAULT_EVENTS)
    : [];
  const value = url
    ? JSON.stringify({
        url,
        secret: cfg?.secret && cfg.secret.length > 0 ? cfg.secret : null,
        events: WEBHOOK_EVENTS.filter((event) => events.includes(event)),
        failStreak: 0,
        enabledAt: now,
        disabledAt: null,
        disabledReason: null,
      })
    : null;
  const stored =
    value === null
      ? sql`NULL`
      : sql`json_set(${value}, '$.generation', ${NEXT_GENERATION})`;
  await db.run(sql`
    INSERT INTO app_settings (key, value, updated_at, updated_by)
    VALUES (${WEBHOOK_KEY}, ${stored}, ${now}, ${updatedBy})
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `);
  // The signing secret is never written to the log: only whether one is set.
  await recordAudit(db, {
    action: AUDIT_ACTIONS.settingsChanged,
    targetType: "setting",
    targetId: WEBHOOK_KEY,
    summary: url
      ? `Set the inbound webhook to ${loggableUrl(url)} (events: ${events.length > 0 ? events.join(", ") : "none"})`
      : "Turned the inbound webhook off",
    details: {
      key: WEBHOOK_KEY,
      url: url ? loggableUrl(url) : null,
      hasSecret: Boolean(cfg?.secret && cfg.secret.length > 0),
      ...(url ? { events } : {}),
    },
  });
}

/**
 * Lift a pause: a new generation, so deliveries recorded before it are
 * cancelled rather than sent. False when no webhook is configured.
 */
export async function enableWebhook(
  db: DrizzleD1Database<any>,
  updatedBy: string | null,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await db.all<{ key: string }>(sql`
    UPDATE app_settings
       SET value = json_set(value, '$.disabledAt', NULL, '$.disabledReason', NULL,
                            '$.failStreak', 0, '$.enabledAt', ${now},
                            '$.generation', ${NEXT_GENERATION}),
           updated_at = ${now},
           updated_by = ${updatedBy}
     WHERE key = ${WEBHOOK_KEY} AND value IS NOT NULL AND json_valid(value)
     RETURNING key
  `);
  if (rows.length === 0) return false;
  await recordAudit(db, {
    action: AUDIT_ACTIONS.webhookEnabled,
    targetType: "setting",
    targetId: WEBHOOK_KEY,
    summary: "Re-enabled the webhook's delivery events",
  });
  return true;
}

/** The stored streak, read inside the statement that changes it. */
const STREAK = sql`COALESCE(json_extract(value, '$.failStreak'), 0)`;
const SAME_GENERATION = (generation: number) =>
  sql`key = ${WEBHOOK_KEY} AND json_valid(value)
      AND COALESCE(json_extract(value, '$.generation'), 0) = ${generation}`;

/**
 * After a delivery of `generation` ended failed: add 1 to the config's
 * `failStreak` and, at `AUTO_DISABLE_AFTER`, pause the outbound events, in
 * one statement. Concurrent failures therefore pause once, and a stale
 * generation never touches a newer save. True when this call paused it (and
 * recorded `webhook.auto_disabled`).
 */
export async function recordFailure(
  db: DrizzleD1Database<any>,
  generation: number,
  last: { status: number | null; error: string | null },
  now: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const lastResult =
    last.status !== null ? `HTTP ${last.status}` : (last.error ?? "no answer");
  const reason = `${AUTO_DISABLE_AFTER} deliveries in a row failed (last: ${lastResult})`;
  const pauses = sql`${STREAK} + 1 >= ${AUTO_DISABLE_AFTER}`;
  const [row] = await db.all<{ disabled_at: number | null }>(sql`
    UPDATE app_settings
       SET value = json_set(value,
                            '$.failStreak', ${STREAK} + 1,
                            '$.disabledAt', CASE WHEN ${pauses} THEN ${now} END,
                            '$.disabledReason', CASE WHEN ${pauses} THEN ${reason} END),
           updated_at = CASE WHEN ${pauses} THEN ${now} ELSE updated_at END
     WHERE ${SAME_GENERATION(generation)}
       AND json_extract(value, '$.disabledAt') IS NULL
     RETURNING json_extract(value, '$.disabledAt') AS disabled_at
  `);
  if (row?.disabled_at == null) return false;
  await recordAudit(db, {
    action: AUDIT_ACTIONS.webhookAutoDisabled,
    targetType: "setting",
    targetId: WEBHOOK_KEY,
    summary: `Paused the webhook's delivery events: ${reason}`,
    details: { key: WEBHOOK_KEY, generation },
  });
  return true;
}

/**
 * After a delivery of `generation` was delivered: the run of failures starts
 * again. Writes nothing when there is no run (the common path).
 */
export async function recordSuccess(
  db: DrizzleD1Database<any>,
  generation: number,
): Promise<void> {
  await db.run(sql`
    UPDATE app_settings
       SET value = json_set(value, '$.failStreak', 0)
     WHERE ${SAME_GENERATION(generation)} AND ${STREAK} > 0
  `);
}
