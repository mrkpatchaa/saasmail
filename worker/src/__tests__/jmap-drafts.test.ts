import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { jmapMessageContent } from "../db/jmap-message-content.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { CORE_CAPABILITY, MAIL_CAPABILITY } from "../jmap/constants";
import { createDraftEmail, Rejection } from "../jmap/email-create";
import { publicBodyPartBlobId } from "../jmap/public-ids";
import { computeConversationId } from "../lib/conversation-id";
import { acct, drf, expectAllJmapIdsValid, rid, sys, thread } from "./jmap-ids";

const MINE = "drafts@saasmail.test";

async function addIdentity(email = MINE, displayName = "Drafts Inbox") {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(senderIdentities).values({
    email,
    displayName,
    createdAt: now,
    updatedAt: now,
  });
}

async function member(id: string, email: string) {
  const auth = await createTestUser({ id, role: "member", email });
  await getDb()
    .insert(inboxPermissions)
    .values({
      userId: auth.userId,
      email: MINE,
      createdAt: Math.floor(Date.now() / 1000),
      createdBy: null,
    });
  return auth;
}

async function jmapJson(apiKey: string, methodCalls: unknown[]) {
  const response = await authFetch("/jmap/api", {
    method: "POST",
    apiKey,
    body: JSON.stringify({
      using: [CORE_CAPABILITY, MAIL_CAPABILITY],
      methodCalls,
    }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    methodResponses: [string, Record<string, any>, string][];
  }>;
}

async function upload(
  apiKey: string,
  userId: string,
  body: string,
  type = "text/plain",
): Promise<string> {
  const response = await authFetch(`/jmap/upload/${acct(userId)}/`, {
    method: "POST",
    apiKey,
    body,
    headers: { "Content-Type": type },
  });
  expect([200, 201]).toContain(response.status);
  return ((await response.json()) as { blobId: string }).blobId;
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    mailboxIds: { [sys(MINE, "drafts")]: true },
    keywords: { $draft: true },
    from: [{ name: "Drafts Inbox", email: MINE }],
    to: [{ name: "Alice", email: "alice@example.com" }],
    subject: "Hello",
    textBody: [{ partId: "t", type: "text/plain" }],
    bodyValues: { t: { value: "Hi there" } },
    ...overrides,
  };
}

type Created = { id: string; blobId: string; threadId: string; size: number };

async function createDraft(
  apiKey: string,
  userId: string,
  overrides: Record<string, unknown> = {},
): Promise<Created> {
  const res = await jmapJson(apiKey, [
    [
      "Email/set",
      { accountId: acct(userId), create: { c1: draft(overrides) } },
      "s",
    ],
  ]);
  const result = res.methodResponses[0][1];
  expect(result.notCreated).toBeNull();
  return result.created.c1 as Created;
}

function envWithFailingPut(failOnCall: number): CloudflareBindings {
  let calls = 0;
  const r2 = new Proxy(env.R2, {
    get(target, prop) {
      if (prop === "put") {
        return async (...args: unknown[]) => {
          calls += 1;
          if (calls === failOnCall) throw new Error("r2 down");
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (target as any).put(...args);
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(env, {
    get(target, prop) {
      return prop === "R2" ? r2 : Reflect.get(target, prop);
    },
  }) as CloudflareBindings;
}

/**
 * cleanDb() only empties D1; R2 objects outlive it, and every test in this file
 * uses the same user id, so a test that lists the whole content prefix would
 * see an earlier test's objects. Wipe both prefixes between tests, the same
 * way jmap-upload.test.ts clears its own.
 */
async function clearR2Prefix(prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await env.R2.list({ prefix, cursor });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length > 0) await env.R2.delete(keys);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

async function clearContentObjects(): Promise<void> {
  await clearR2Prefix("jmap-content/");
  await clearR2Prefix("jmap-uploads/");
}

describe("JMAP drafts", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    await clearContentObjects();
    await addIdentity();
  });

  describe("create", () => {
    it("creates a draft and returns id, blobId, threadId and size", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const res = await jmapJson(apiKey, [
        [
          "Email/set",
          { accountId: acct(userId), create: { c1: draft() } },
          "s",
        ],
      ]);
      expectAllJmapIdsValid(res);
      const created = res.methodResponses[0][1].created.c1 as Created;
      expect(created.id).toMatch(/^D/);
      expect(created.blobId).toMatch(/^X/);
      expect(created.threadId).toMatch(/^T/);
      expect(created.size).toBeGreaterThan(0);

      const [row] = await getDb().select().from(jmapDrafts);
      expect(row.id).toBe(created.id.slice(1));
      expect(row.contentId).toBe(created.blobId.slice(1));
      const [content] = await getDb().select().from(jmapMessageContent);
      expect(content.size).toBe(created.size);
      const object = await env.R2.get(content.rawR2Key);
      expect((await object!.arrayBuffer()).byteLength).toBe(created.size);
    });

    it("requires the identity's Drafts mailbox and a usable identity", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const res = await jmapJson(apiKey, [
        [
          "Email/set",
          {
            accountId: acct(userId),
            create: {
              inbox: draft({ mailboxIds: { [sys(MINE, "inbox")]: true } }),
              stranger: draft({ from: [{ email: "stranger@example.com" }] }),
            },
          },
          "s",
        ],
      ]);
      expect(res.methodResponses[0][1].notCreated).toEqual({
        inbox: { type: "invalidProperties", properties: ["mailboxIds"] },
        stranger: { type: "invalidProperties", properties: ["from"] },
      });
    });

    it("reports every missing blob in blobNotFound", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const other = await createTestUser({
        id: "otheruser",
        email: "other@example.com",
      });
      const foreign = await upload(other.apiKey, other.userId, "not yours");
      const res = await jmapJson(apiKey, [
        [
          "Email/set",
          {
            accountId: acct(userId),
            create: {
              c1: draft({
                attachments: [{ blobId: "Umissing" }, { blobId: foreign }],
              }),
            },
          },
          "s",
        ],
      ]);
      expect(res.methodResponses[0][1].notCreated.c1).toEqual({
        type: "blobNotFound",
        notFound: ["Umissing", foreign],
      });
      expect(await getDb().select().from(jmapMessageContent)).toEqual([]);
    });

    it("rejects attachments over maxSizeAttachmentsPerEmail with tooLarge", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const blobId = await upload(apiKey, userId, "four");
      const result = await createDraftEmail(
        {
          db: getDb(),
          env,
          allowed: { isAdmin: true },
          userId,
          maxAttachmentBytes: 3,
          now: Math.floor(Date.now() / 1000),
        },
        draft({ attachments: [{ blobId }] }),
      );
      expect(result).toBeInstanceOf(Rejection);
      expect((result as Rejection).error.type).toBe("tooLarge");
    });

    it("leaves neither rows nor R2 objects when an R2 write fails", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const blobId = await upload(apiKey, userId, "hello");
      await expect(
        createDraftEmail(
          {
            db: getDb(),
            env: envWithFailingPut(1),
            allowed: { isAdmin: true },
            userId,
            maxAttachmentBytes: 1_000_000,
            now: Math.floor(Date.now() / 1000),
          },
          draft({ attachments: [{ blobId }] }),
        ),
      ).rejects.toThrow("r2 down");
      expect(await getDb().select().from(jmapMessageContent)).toEqual([]);
      expect(await getDb().select().from(jmapDrafts)).toEqual([]);
      const listed = await env.R2.list({ prefix: `jmap-content/${userId}/` });
      expect(listed.objects).toEqual([]);
    });

    it("joins the thread of the message it replies to (either Message-ID form)", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      await createTestPerson();
      await createTestEmail({
        id: "orig",
        recipient: MINE,
        messageId: "<orig@example.com>",
        conversationId: "c_0123456789abcdef",
      });
      const created = await createDraft(apiKey, userId, {
        inReplyTo: ["orig@example.com"],
      });
      expect(created.threadId).toBe(thread("c_0123456789abcdef"));
    });

    it("otherwise uses the conversation key, then the person key, then its own thread", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const group = await createDraft(apiKey, userId, {
        cc: [{ email: "bob@example.com" }],
      });
      const conversation = await computeConversationId(MINE, [
        "alice@example.com",
        "bob@example.com",
      ]);
      expect(group.threadId).toBe(thread(conversation!));

      await createTestPerson({
        id: "person-alice",
        email: "alice@example.com",
      });
      const person = await createDraft(apiKey, userId);
      expect(person.threadId).toBe(thread("p:person-alice"));

      const alone = await createDraft(apiKey, userId, {
        to: [{ email: "nobody@example.com" }],
      });
      expect(alone.threadId).toBe(`Td${alone.id.slice(1)}`);
    });
  });

  describe("get", () => {
    it("returns a draft's immutable properties and server-set values", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const created = await createDraft(apiKey, userId);
      const res = await jmapJson(apiKey, [
        [
          "Email/get",
          {
            accountId: acct(userId),
            ids: [created.id],
            fetchAllBodyValues: true,
          },
          "g",
        ],
      ]);
      expectAllJmapIdsValid(res);
      const email = res.methodResponses[0][1].list[0];
      expect(email).toMatchObject({
        id: created.id,
        blobId: created.blobId,
        threadId: created.threadId,
        size: created.size,
        mailboxIds: { [sys(MINE, "drafts")]: true },
        keywords: { $draft: true },
        from: [{ name: "Drafts Inbox", email: MINE }],
        to: [{ name: "Alice", email: "alice@example.com" }],
        cc: null,
        subject: "Hello",
        hasAttachment: false,
        preview: "Hi there",
        textBody: [
          {
            partId: "1",
            type: "text/plain",
            size: 8,
            blobId: publicBodyPartBlobId(created.id, "1"),
          },
        ],
        bodyValues: {
          "1": {
            value: "Hi there",
            isEncodingProblem: false,
            isTruncated: false,
          },
        },
      });
      expect(email.messageId).toEqual([
        expect.stringMatching(/^[A-Za-z0-9_-]+@saasmail\.test$/),
      ]);
      expect(email.sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(email.receivedAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      );
    });

    it("keeps client-set messageId, sentAt and receivedAt", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const created = await createDraft(apiKey, userId, {
        messageId: ["client-id@example.com"],
        sentAt: "2026-09-26T12:00:00+02:00",
        receivedAt: "2026-09-20T08:00:00Z",
      });
      const res = await jmapJson(apiKey, [
        [
          "Email/get",
          {
            accountId: acct(userId),
            ids: [created.id],
            properties: ["messageId", "sentAt", "receivedAt"],
          },
          "g",
        ],
      ]);
      expect(res.methodResponses[0][1].list[0]).toEqual({
        id: created.id,
        messageId: ["client-id@example.com"],
        sentAt: "2026-09-26T12:00:00+02:00",
        receivedAt: "2026-09-20T08:00:00Z",
      });
    });

    it("projects text, html and an attachment into structure and lists", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const blobId = await upload(apiKey, userId, "hello");
      const created = await createDraft(apiKey, userId, {
        htmlBody: [{ partId: "h", type: "text/html" }],
        bodyValues: { t: { value: "Hi" }, h: { value: "<p>Hi</p>" } },
        attachments: [{ blobId, type: "text/plain", name: "a.txt" }],
      });
      const res = await jmapJson(apiKey, [
        ["Email/get", { accountId: acct(userId), ids: [created.id] }, "g"],
      ]);
      const email = res.methodResponses[0][1].list[0];
      expect(email.bodyStructure.type).toBe("multipart/mixed");
      expect(email.bodyStructure.subParts[0].type).toBe(
        "multipart/alternative",
      );
      expect(email.textBody.map((part: any) => part.partId)).toEqual(["1"]);
      expect(email.htmlBody.map((part: any) => part.partId)).toEqual(["2"]);
      expect(email.attachments).toEqual([
        {
          partId: "3",
          blobId: publicBodyPartBlobId(created.id, "3"),
          size: 5,
          name: "a.txt",
          type: "text/plain",
          charset: null,
          disposition: "attachment",
          cid: null,
          language: null,
          location: null,
        },
      ]);
      expect(email.hasAttachment).toBe(true);
    });

    it("truncates body values to maxBodyValueBytes on a character boundary", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const created = await createDraft(apiKey, userId, {
        bodyValues: { t: { value: "héllo" } },
      });
      const res = await jmapJson(apiKey, [
        [
          "Email/get",
          {
            accountId: acct(userId),
            ids: [created.id],
            fetchTextBodyValues: true,
            maxBodyValueBytes: 2,
          },
          "g",
        ],
      ]);
      // "h" (1 octet) + "é" (2 octets) would be 3 > 2, so only "h" survives.
      expect(res.methodResponses[0][1].list[0].bodyValues["1"]).toEqual({
        value: "h",
        isEncodingProblem: false,
        isTruncated: true,
      });
    });

    it("lists drafts with ids: null and reports malformed or unknown draft ids as notFound", async () => {
      const { userId, apiKey } = await createTestUser({ id: "drafter" });
      const created = await createDraft(apiKey, userId);
      const res = await jmapJson(apiKey, [
        [
          "Email/get",
          { accountId: acct(userId), ids: null, properties: ["id"] },
          "all",
        ],
        [
          "Email/get",
          { accountId: acct(userId), ids: ["D", "Dnope", "d!!", drf("x")] },
          "bad",
        ],
      ]);
      expect(res.methodResponses[0][1].list).toEqual([{ id: created.id }]);
      expect(res.methodResponses[1][1].notFound).toEqual([
        "D",
        "Dnope",
        "d!!",
        drf("x"),
      ]);
    });
  });
});
