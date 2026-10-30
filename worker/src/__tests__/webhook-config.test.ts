import { beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import {
  enableWebhook,
  getWebhookConfig,
  maybeAutoDisable,
  setWebhookConfig,
  webhookWants,
} from "../lib/webhook-config";
import { appSettings } from "../db/app-settings.schema";
import { auditEvents } from "../db/audit-events.schema";
import { webhookDeliveries } from "../db/webhook-deliveries.schema";

beforeEach(async () => {
  await applyMigrations();
  await cleanDb();
});

describe("webhook-config", () => {
  it("returns null when unconfigured", async () => {
    expect(await getWebhookConfig(getDb())).toBeNull();
  });

  it("round-trips url + secret", async () => {
    await setWebhookConfig(
      getDb(),
      { url: "https://hook.example.com", secret: "whsec_abc" },
      "user-1",
    );
    expect(await getWebhookConfig(getDb())).toMatchObject({
      url: "https://hook.example.com",
      secret: "whsec_abc",
    });
  });

  it("treats empty/whitespace url as disabled (null)", async () => {
    await setWebhookConfig(getDb(), { url: "   ", secret: "x" }, "user-1");
    expect(await getWebhookConfig(getDb())).toBeNull();
  });

  it("stores a null secret when none provided", async () => {
    await setWebhookConfig(
      getDb(),
      { url: "https://hook.example.com", secret: null },
      "user-1",
    );
    expect(await getWebhookConfig(getDb())).toMatchObject({
      url: "https://hook.example.com",
      secret: null,
    });
  });

  it("returns null on malformed stored JSON (no throw)", async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(appSettings)
      .values({
        key: "webhook",
        value: "{not json",
        updatedAt: now,
        updatedBy: null,
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: "{not json", updatedAt: now, updatedBy: null },
      });
    expect(await getWebhookConfig(getDb())).toBeNull();
  });
});

// docs/webhooks.md: the event list and the pause after 20 failures in a row.
describe("webhook events and auto-disable", () => {
  const now = Math.floor(Date.now() / 1000);

  async function storeRaw(value: string) {
    await getDb()
      .insert(appSettings)
      .values({ key: "webhook", value, updatedAt: now, updatedBy: null })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value, updatedAt: now },
      });
  }

  async function current() {
    const cfg = await getWebhookConfig(getDb());
    if (!cfg) throw new Error("no config");
    return cfg;
  }

  let seq = 0;
  async function finished(
    generation: number,
    status: "failed" | "delivered" | "cancelled",
    count: number,
    finishedAt: number,
  ) {
    for (let i = 0; i < count; i += 1) {
      seq += 1;
      await getDb()
        .insert(webhookDeliveries)
        .values({
          id: `wd_${seq}`,
          sourceKey: `sent:s${seq}:message.sent`,
          event: "message.sent",
          messageId: `s${seq}`,
          generation,
          status,
          attempts: 4,
          lastStatus: 500,
          nextAttemptAt: finishedAt,
          createdAt: finishedAt,
          finishedAt,
        });
    }
  }

  const pauses = async () =>
    (await getDb().select().from(auditEvents)).filter(
      (e) => e.action === "webhook.auto_disabled",
    );

  it("reads a config stored without events as message.received only", async () => {
    await storeRaw(
      JSON.stringify({ url: "https://hook.example.com", secret: null }),
    );
    expect(await current()).toMatchObject({
      events: ["message.received"],
      generation: 0,
      disabledAt: null,
    });
  });

  it("drops unknown event names and keeps an empty list", async () => {
    await storeRaw(
      JSON.stringify({
        url: "https://hook.example.com",
        events: ["message.sent", "message.opened"],
      }),
    );
    expect((await current()).events).toEqual(["message.sent"]);
    await setWebhookConfig(
      getDb(),
      { url: "https://hook.example.com", secret: null, events: [] },
      null,
    );
    const cfg = await current();
    expect(cfg.events).toEqual([]);
    expect(webhookWants(cfg, "message.received")).toBe(false);
  });

  it("starts a new generation on every save, also after the config was cleared", async () => {
    await setWebhookConfig(
      getDb(),
      { url: "https://a.example.com", secret: null },
      null,
    );
    expect((await current()).generation).toBe(1);
    await finished(5, "failed", 1, now);
    await setWebhookConfig(getDb(), null, null);
    await setWebhookConfig(
      getDb(),
      { url: "https://b.example.com", secret: null },
      null,
    );
    expect((await current()).generation).toBe(6);
  });

  it("pauses once after 20 failures in a row, even when two consumers finish the 20th together", async () => {
    await setWebhookConfig(
      getDb(),
      {
        url: "https://hook.example.com",
        secret: null,
        events: ["message.sent"],
      },
      null,
    );
    const { generation } = await current();
    await finished(generation, "failed", 19, now);
    expect(
      await maybeAutoDisable(getDb(), generation, { status: 500, error: null }),
    ).toBe(false);
    await finished(generation, "failed", 2, now + 1);
    const results = await Promise.all([
      maybeAutoDisable(getDb(), generation, { status: 503, error: null }),
      maybeAutoDisable(getDb(), generation, { status: 503, error: null }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const cfg = await current();
    expect(cfg.disabledAt).not.toBeNull();
    expect(cfg.disabledReason).toContain("HTTP 503");
    expect(webhookWants(cfg, "message.sent")).toBe(false);
    expect(await pauses()).toHaveLength(1);

    // Re-enable lifts it, in a new generation, and is audited.
    expect(await enableWebhook(getDb(), null)).toBe(true);
    const enabled = await current();
    expect(enabled).toMatchObject({ disabledAt: null, disabledReason: null });
    expect(enabled.generation).toBe(generation + 1);
    expect(webhookWants(enabled, "message.sent")).toBe(true);
    const audit = await getDb().select().from(auditEvents);
    expect(audit.some((e) => e.action === "webhook.enabled")).toBe(true);
  });

  it("does not let a stale generation pause a newer save", async () => {
    await setWebhookConfig(
      getDb(),
      { url: "https://hook.example.com", secret: null },
      null,
    );
    const { generation } = await current();
    await finished(generation, "failed", 20, now);
    await setWebhookConfig(
      getDb(),
      { url: "https://hook.example.com", secret: null },
      null,
    );
    expect(
      await maybeAutoDisable(getDb(), generation, { status: 500, error: null }),
    ).toBe(false);
    expect((await current()).disabledAt).toBeNull();
    expect(await pauses()).toEqual([]);
  });

  it("starts the run again after a success, and ignores cancelled rows", async () => {
    await setWebhookConfig(
      getDb(),
      { url: "https://hook.example.com", secret: null },
      null,
    );
    const { generation } = await current();
    await finished(generation, "failed", 15, now);
    await finished(generation, "delivered", 1, now + 1);
    await finished(generation, "cancelled", 10, now + 2);
    await finished(generation, "failed", 19, now + 2);
    expect(
      await maybeAutoDisable(getDb(), generation, { status: 500, error: null }),
    ).toBe(false);
    await finished(generation, "failed", 1, now + 3);
    expect(
      await maybeAutoDisable(getDb(), generation, { status: 500, error: null }),
    ).toBe(true);
  });
});
