import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestAttachment,
  createTestEmail,
  createTestPerson,
  createTestSentEmail,
  createTestUser,
  getDb,
} from "./helpers";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { mailboxes } from "../db/mailboxes.schema";
import { messageMailboxes } from "../db/message-mailboxes.schema";
import { messageUserState } from "../db/message-user-state.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import {
  CORE_CAPABILITY,
  MAIL_CAPABILITY,
  MAX_CALLS_IN_REQUEST,
} from "../jmap/constants";

const MINE = "mine@saasmail.test";
const THEIRS = "theirs@saasmail.test";

async function addIdentity(email: string, displayName = "Inbox") {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(senderIdentities).values({
    email,
    displayName,
    createdAt: now,
    updatedAt: now,
  });
}

async function jmap(
  apiKey: string,
  methodCalls: unknown[],
  using = [CORE_CAPABILITY, MAIL_CAPABILITY],
) {
  return authFetch("/jmap/api", {
    method: "POST",
    apiKey,
    body: JSON.stringify({ using, methodCalls }),
  });
}

async function jmapJson(
  apiKey: string,
  methodCalls: unknown[],
  using = [CORE_CAPABILITY, MAIL_CAPABILITY],
) {
  const response = await jmap(apiKey, methodCalls, using);
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    methodResponses: [string, Record<string, any>, string][];
  }>;
}

async function createMember() {
  const { userId, apiKey } = await createTestUser({
    id: "jmap-member",
    role: "member",
    email: "member@example.com",
  });
  await getDb()
    .insert(inboxPermissions)
    .values({
      userId,
      email: MINE,
      createdAt: Math.floor(Date.now() / 1000),
      createdBy: null,
    });
  return { userId, apiKey };
}

describe("read-only JMAP", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  it("serves the RFC 8620 session shape and requires authentication", async () => {
    const unauthorized = await authFetch("/.well-known/jmap");
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("Content-Type")).toContain(
      "application/problem+json",
    );

    const { userId, apiKey } = await createTestUser({ id: "jmap-user" });
    await addIdentity(MINE);
    const response = await authFetch("/.well-known/jmap", { apiKey });
    expect(response.status).toBe(200);
    const session = (await response.json()) as any;

    expect(session.apiUrl).toBe("/jmap/api");
    expect(session.downloadUrl).toBe(
      "/jmap/download/{accountId}/{blobId}/{name}?type={type}",
    );
    expect(session.uploadUrl).toBe("");
    expect(session.eventSourceUrl).toBe("");
    expect(session.capabilities[CORE_CAPABILITY]).toMatchObject({
      maxSizeRequest: 10_000_000,
      maxCallsInRequest: 16,
      maxObjectsInGet: 256,
      maxConcurrentRequests: 4,
      collationAlgorithms: ["i;ascii-casemap"],
    });
    expect(session.capabilities[MAIL_CAPABILITY]).toEqual({});
    expect(session.accounts[userId]).toMatchObject({
      isPersonal: true,
      isReadOnly: true,
    });
    expect(session.primaryAccounts[MAIL_CAPABILITY]).toBe(userId);
  });

  it("supports Core/echo, rejects bad capabilities, and enforces the call limit", async () => {
    const { apiKey } = await createTestUser({ id: "jmap-user" });
    const echo = await jmapJson(apiKey, [
      ["Core/echo", { hello: "world" }, "c1"],
    ]);
    expect(echo.methodResponses[0]).toEqual([
      "Core/echo",
      { hello: "world" },
      "c1",
    ]);

    const capability = await jmap(
      apiKey,
      [["Core/echo", {}, "c1"]],
      [CORE_CAPABILITY, "urn:example:unknown"],
    );
    expect(capability.status).toBe(400);
    expect(((await capability.json()) as any).type).toBe(
      "urn:ietf:params:jmap:error:unknownCapability",
    );

    const tooMany = await jmap(
      apiKey,
      Array.from({ length: MAX_CALLS_IN_REQUEST + 1 }, (_, index) => [
        "Core/echo",
        {},
        `c${index}`,
      ]),
    );
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toMatchObject({
      type: "urn:ietf:params:jmap:error:limit",
      limit: "maxCallsInRequest",
    });
  });

  it("exposes virtual and custom mailboxes plus usable identities", async () => {
    const { userId, apiKey } = await createTestUser({ id: "jmap-user" });
    await addIdentity(MINE, "Support");
    await createTestPerson({ id: "person-1", email: "alice@example.com" });
    await createTestEmail({
      id: "mail-1",
      personId: "person-1",
      recipient: MINE,
      isRead: 0,
    });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(mailboxes).values({
      id: "folder-1",
      inbox: MINE,
      name: "VIP",
      role: null,
      parentId: null,
      sortOrder: 2,
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });
    await getDb().insert(messageMailboxes).values({
      messageKind: "received",
      messageId: "mail-1",
      mailboxId: "folder-1",
      addedBy: userId,
      addedAt: now,
    });

    const result = await jmapJson(apiKey, [
      ["Mailbox/get", { accountId: userId }, "m1"],
      ["Mailbox/query", { accountId: userId }, "m2"],
      ["Identity/get", { accountId: userId }, "i1"],
    ]);

    const mailboxGet = result.methodResponses[0][1];
    expect(mailboxGet.list.map((mailbox: any) => mailbox.id)).toEqual(
      expect.arrayContaining([
        `sys:${MINE}:inbox`,
        `sys:${MINE}:drafts`,
        `sys:${MINE}:sent`,
        `sys:${MINE}:archive`,
        `sys:${MINE}:junk`,
        `sys:${MINE}:trash`,
        "mbx:folder-1",
      ]),
    );
    const inbox = mailboxGet.list.find(
      (mailbox: any) => mailbox.id === `sys:${MINE}:inbox`,
    );
    expect(inbox).toMatchObject({
      role: "inbox",
      totalEmails: 1,
      unreadEmails: 1,
      myRights: { mayReadItems: true, mayDelete: false },
    });
    expect(result.methodResponses[1][1].ids).toContain("mbx:folder-1");
    expect(result.methodResponses[2][1].list).toEqual([
      expect.objectContaining({
        email: MINE,
        name: "Support",
        mayDelete: false,
      }),
    ]);
  });

  it("returns Email/get fields, body values, state keywords, and attachment blob ids", async () => {
    const { userId, apiKey } = await createTestUser({ id: "jmap-user" });
    await addIdentity(MINE);
    await createTestPerson({ id: "person-1", email: "alice@example.com" });
    await createTestEmail({
      id: "mail-1",
      personId: "person-1",
      recipient: MINE,
      subject: "Hello JMAP",
      bodyText: "Visible plain text",
      conversationId: "conv-1",
      cc: JSON.stringify([{ email: "cc@example.com", name: "Cc" }]),
    });
    const now = Math.floor(Date.now() / 1000);
    await getDb().insert(messageUserState).values({
      userId,
      messageKind: "received",
      messageId: "mail-1",
      seenAt: now,
      starredAt: now,
      updatedAt: now,
    });
    const attachment = await createTestAttachment({
      id: "blob-1",
      emailId: "mail-1",
      kind: "inbound",
      filename: "hello.txt",
      contentType: "text/plain",
      size: 5,
      r2Key: "jmap/mail-1/hello.txt",
    });
    await env.R2.put(attachment.r2Key, new TextEncoder().encode("hello"));

    const result = await jmapJson(apiKey, [
      [
        "Email/get",
        {
          accountId: userId,
          ids: ["received:mail-1"],
          fetchTextBodyValues: true,
          fetchHTMLBodyValues: true,
        },
        "e1",
      ],
    ]);
    const email = result.methodResponses[0][1].list[0];
    expect(email).toMatchObject({
      id: "received:mail-1",
      subject: "Hello JMAP",
      preview: "Visible plain text",
      hasAttachment: true,
      keywords: { $seen: true, $flagged: true },
      mailboxIds: { [`sys:${MINE}:inbox`]: true },
      bodyValues: {
        text: { value: "Visible plain text" },
        html: { value: "<p>Hello</p>" },
      },
    });
    expect(email.threadId).toBeTruthy();
    expect(email.attachments).toEqual([
      expect.objectContaining({ blobId: "blob-1", name: "hello.txt" }),
    ]);
  });

  it("queries email with supported filters and only receivedAt descending sort", async () => {
    const { userId, apiKey } = await createTestUser({ id: "jmap-user" });
    await addIdentity(MINE);
    await createTestPerson({ id: "alice", email: "alice@example.com" });
    await createTestPerson({ id: "bob", email: "bob@example.com" });
    await createTestEmail({
      id: "alice-mail",
      personId: "alice",
      recipient: MINE,
      subject: "Project alpha",
      bodyText: "keyword body",
      isRead: 1,
    });
    await createTestEmail({
      id: "bob-mail",
      personId: "bob",
      recipient: MINE,
      subject: "Other",
      bodyText: "other body",
      messageId: "bob-message@example.com",
    });

    const filtered = await jmapJson(apiKey, [
      [
        "Email/query",
        {
          accountId: userId,
          filter: {
            inMailbox: `sys:${MINE}:inbox`,
            text: "alpha",
            from: "alice@",
            hasKeyword: "$seen",
          },
          sort: [{ property: "receivedAt", isAscending: false }],
          position: 0,
          limit: 10,
          collapseThreads: false,
        },
        "q1",
      ],
      [
        "Email/query",
        {
          accountId: userId,
          sort: [{ property: "receivedAt", isAscending: true }],
        },
        "q2",
      ],
    ]);
    expect(filtered.methodResponses[0][1]).toMatchObject({
      ids: ["received:alice-mail"],
      total: 1,
      canCalculateChanges: false,
    });
    expect(filtered.methodResponses[1]).toEqual([
      "error",
      { type: "unsupportedSort" },
      "q2",
    ]);
  });

  it("supports result references and Thread/get", async () => {
    const { userId, apiKey } = await createTestUser({ id: "jmap-user" });
    await addIdentity(MINE);
    await createTestPerson({ id: "person-1", email: "alice@example.com" });
    await createTestEmail({
      id: "received-1",
      personId: "person-1",
      recipient: MINE,
      conversationId: "conv-1",
    });
    await createTestSentEmail({
      id: "sent-1",
      personId: "person-1",
      fromAddress: MINE,
      toAddress: "alice@example.com",
      conversationId: "conv-1",
    });

    const result = await jmapJson(apiKey, [
      ["Email/query", { accountId: userId }, "q1"],
      [
        "Email/get",
        {
          accountId: userId,
          "#ids": { resultOf: "q1", name: "Email/query", path: "/ids" },
        },
        "g1",
      ],
      [
        "Thread/get",
        {
          accountId: userId,
          "#ids": {
            resultOf: "g1",
            name: "Email/get",
            path: "/list/*/threadId",
          },
        },
        "t1",
      ],
    ]);

    expect(result.methodResponses[1][0]).toBe("Email/get");
    expect(result.methodResponses[1][1].list).toHaveLength(2);
    expect(result.methodResponses[2][0]).toBe("Thread/get");
    expect(result.methodResponses[2][1].list[0].emailIds).toEqual(
      expect.arrayContaining(["received:received-1", "sent:sent-1"]),
    );
  });

  it("returns invalidResultReference and cannotCalculateChanges per call", async () => {
    const { userId, apiKey } = await createTestUser({ id: "jmap-user" });
    const methodCalls: unknown[] = [
      [
        "Email/get",
        {
          accountId: userId,
          "#ids": { resultOf: "missing", name: "Email/query", path: "/ids" },
        },
        "bad-ref",
      ],
    ];
    for (const [index, name] of [
      "Mailbox/changes",
      "Mailbox/queryChanges",
      "Email/changes",
      "Email/queryChanges",
      "Thread/changes",
      "Thread/queryChanges",
      "Identity/changes",
      "Identity/queryChanges",
    ].entries()) {
      methodCalls.push([name, { accountId: userId }, `ch-${index}`]);
    }

    const result = await jmapJson(apiKey, methodCalls);
    expect(result.methodResponses[0]).toEqual([
      "error",
      { type: "invalidResultReference" },
      "bad-ref",
    ]);
    for (const response of result.methodResponses.slice(1)) {
      expect(response[0]).toBe("error");
      expect(response[1]).toEqual({ type: "cannotCalculateChanges" });
    }
  });

  it("hides another inbox's ids from a member", async () => {
    await addIdentity(MINE);
    await addIdentity(THEIRS);
    await createTestPerson({ id: "person-1", email: "alice@example.com" });
    await createTestEmail({
      id: "theirs-1",
      personId: "person-1",
      recipient: THEIRS,
    });
    const { userId, apiKey } = await createMember();

    const result = await jmapJson(apiKey, [
      ["Email/get", { accountId: userId, ids: ["received:theirs-1"] }, "e1"],
      [
        "Mailbox/get",
        { accountId: userId, ids: [`sys:${THEIRS}:inbox`] },
        "m1",
      ],
    ]);
    expect(result.methodResponses[0][1]).toMatchObject({
      list: [],
      notFound: ["received:theirs-1"],
    });
    expect(result.methodResponses[1][1]).toMatchObject({
      list: [],
      notFound: [`sys:${THEIRS}:inbox`],
    });
  });

  it("downloads only permission-scoped attachment blobs", async () => {
    await addIdentity(MINE);
    await addIdentity(THEIRS);
    await createTestPerson({ id: "person-1", email: "alice@example.com" });
    await createTestEmail({
      id: "mine-1",
      personId: "person-1",
      recipient: MINE,
    });
    await createTestEmail({
      id: "theirs-1",
      personId: "person-1",
      recipient: THEIRS,
      messageId: "theirs-message@example.com",
    });
    const mine = await createTestAttachment({
      id: "mine-blob",
      emailId: "mine-1",
      r2Key: "jmap/mine.txt",
      filename: "mine.txt",
    });
    const theirs = await createTestAttachment({
      id: "theirs-blob",
      emailId: "theirs-1",
      r2Key: "jmap/theirs.txt",
      filename: "theirs.txt",
    });
    await env.R2.put(mine.r2Key, new TextEncoder().encode("m"));
    await env.R2.put(theirs.r2Key, new TextEncoder().encode("t"));
    const { userId, apiKey } = await createMember();

    const readable = await authFetch(
      `/jmap/download/${userId}/mine-blob/mine.txt?type=text/plain`,
      { apiKey },
    );
    expect(readable.status).toBe(200);
    expect(await readable.text()).toBe("m");

    const hidden = await authFetch(
      `/jmap/download/${userId}/theirs-blob/theirs.txt?type=text/plain`,
      { apiKey },
    );
    expect(hidden.status).toBe(404);
  });
});
