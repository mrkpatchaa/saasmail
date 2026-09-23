import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { lists } from "../db/lists.schema";
import { sequences } from "../db/sequences.schema";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";

describe("agent approval summaries", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("summarizes visible entities from D1 and hides out-of-scope targets", async () => {
    const member = await createTestUser({
      id: "approval-summary-member",
      role: "member",
      email: "approval-summary-member@example.com",
    });
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(inboxPermissions).values({
      userId: member.userId,
      email: "allowed@example.com",
      createdAt: now,
      createdBy: null,
    });

    const visible = await createTestPerson({
      id: "approval-summary-person",
      email: "jane@acme.com",
      name: "Jane",
    });
    await createTestEmail({
      id: "approval-summary-email",
      personId: visible.id,
      recipient: "allowed@example.com",
      messageId: "approval-summary-email@example.com",
    });

    await db.insert(sequences).values({
      id: "approval-summary-sequence",
      name: "Onboarding",
      steps: JSON.stringify([
        { order: 1, templateSlug: "one", delayHours: 0 },
        { order: 2, templateSlug: "two", delayHours: 120 },
        { order: 3, templateSlug: "three", delayHours: 120 },
      ]),
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(lists).values([
      {
        id: "approval-summary-list",
        name: "Beta testers",
        description: null,
        fromAddress: "allowed@example.com",
        doubleOptIn: 0,
        confirmationTemplateSlug: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "approval-summary-hidden-list",
        name: "Hidden",
        description: null,
        fromAddress: "denied@example.com",
        doubleOptIn: 0,
        confirmationTemplateSlug: null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const enroll = await authFetch("/api/agent/approval-summary", {
      method: "POST",
      apiKey: member.apiKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "enroll_in_sequence",
        input: {
          personId: visible.id,
          sequenceId: "approval-summary-sequence",
        },
      }),
    });
    expect(enroll.status).toBe(200);
    expect(await enroll.json()).toEqual({
      summary: "Enroll jane@acme.com in 'Onboarding' (3 emails over 10 days)",
    });

    const list = await authFetch("/api/agent/approval-summary", {
      method: "POST",
      apiKey: member.apiKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "add_to_list",
        input: { personId: visible.id, listId: "approval-summary-list" },
      }),
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      summary: "Add jane@acme.com to list 'Beta testers'",
    });

    const hidden = await authFetch("/api/agent/approval-summary", {
      method: "POST",
      apiKey: member.apiKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "add_to_list",
        input: {
          personId: visible.id,
          listId: "approval-summary-hidden-list",
        },
      }),
    });
    expect(hidden.status).toBe(404);

    await db
      .delete(inboxPermissions)
      .where(eq(inboxPermissions.userId, member.userId));

    const revoked = await authFetch("/api/agent/approval-summary", {
      method: "POST",
      apiKey: member.apiKey,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName: "enroll_in_sequence",
        input: {
          personId: visible.id,
          sequenceId: "approval-summary-sequence",
        },
      }),
    });
    expect(revoked.status).toBe(404);
  });
});
