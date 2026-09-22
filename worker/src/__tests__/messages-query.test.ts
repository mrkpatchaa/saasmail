import { describe, expect, it, beforeAll, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  cleanDb,
  createTestPerson,
  getDb,
} from "./helpers";
import { attachments } from "../db/attachments.schema";
import { blocklist } from "../db/blocklist.schema";
import { emails } from "../db/emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { queryMessages } from "../lib/messages/query";

describe("queryMessages", () => {
  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
  });

  async function seedPair() {
    const db = getDb();
    await createTestPerson({
      id: "person-1",
      email: "alice@example.com",
      name: "Alice",
    });

    await db.insert(emails).values({
      id: "recv-1",
      personId: "person-1",
      recipient: "Support@saasmail.test",
      subject: "Invoice received",
      bodyHtml: "<p>secret inbound body</p>",
      bodyText: "secret inbound body",
      rawHeaders: "{}",
      messageId: "recv-1@example.com",
      isRead: 0,
      conversationId: "conv-1",
      receivedAt: 300,
      createdAt: 300,
    });

    await db.insert(sentEmails).values({
      id: "sent-1",
      personId: "person-1",
      fromAddress: "support@saasmail.test",
      toAddress: "alice@example.com",
      subject: "Invoice sent",
      bodyHtml: "<p>secret outbound body</p>",
      bodyText: "secret outbound body",
      messageId: "sent-1@example.com",
      status: "sent",
      conversationId: "conv-1",
      campaignId: "campaign-1",
      sentAt: 200,
      createdAt: 200,
    });
  }

  it("merges both directions and scopes stored inbox casing correctly", async () => {
    await seedPair();

    const page = await queryMessages(
      getDb(),
      { isAdmin: false, inboxes: ["support@saasmail.test"] },
      { limit: 10 },
    );

    expect(page.messages.map((message) => message.ref)).toEqual([
      { kind: "received", id: "recv-1" },
      { kind: "sent", id: "sent-1" },
    ]);
    expect(page.messages[0].from).toEqual({
      email: "alice@example.com",
      name: "Alice",
    });
    expect(page.messages[1].to.name).toBe("Alice");
  });

  it("silently excludes explicitly unauthorized inboxes", async () => {
    await seedPair();

    const page = await queryMessages(
      getDb(),
      { isAdmin: false, inboxes: ["support@saasmail.test"] },
      { inboxes: ["billing@saasmail.test"] },
    );

    expect(page.messages).toEqual([]);
  });

  it("keeps subject-only and full-text search semantics distinct", async () => {
    await seedPair();
    const db = getDb();

    const subjectOnly = await queryMessages(
      db,
      { isAdmin: true },
      { search: "secret", searchMode: "subject" },
    );
    expect(subjectOnly.messages).toEqual([]);

    const fulltext = await queryMessages(
      db,
      { isAdmin: true },
      { search: "secret", searchMode: "fulltext" },
    );
    expect(fulltext.messages.map((message) => message.ref.id)).toEqual([
      "recv-1",
      "sent-1",
    ]);
  });

  it("makes blocklist filtering opt-in", async () => {
    await seedPair();
    const db = getDb();
    await db.insert(blocklist).values({
      id: "block-1",
      type: "email",
      value: "alice@example.com",
      note: null,
      createdBy: null,
      createdAt: 1,
    });

    const ordinary = await queryMessages(db, { isAdmin: true }, {});
    expect(ordinary.messages).toHaveLength(2);

    const filtered = await queryMessages(
      db,
      { isAdmin: true },
      { excludeBlocked: true },
    );
    expect(filtered.messages).toEqual([]);
  });

  it("enriches attachment counts and arrays for both message kinds", async () => {
    await seedPair();
    const db = getDb();
    await db.insert(attachments).values([
      {
        id: "att-in",
        emailId: "recv-1",
        kind: "inbound",
        filename: "in.txt",
        contentType: "text/plain",
        size: 1,
        r2Key: "in",
        contentId: null,
        createdAt: 1,
      },
      {
        id: "att-out",
        emailId: "sent-1",
        kind: "sent",
        filename: "out.txt",
        contentType: "text/plain",
        size: 1,
        r2Key: "out",
        contentId: null,
        createdAt: 1,
      },
    ]);

    const page = await queryMessages(
      db,
      { isAdmin: true },
      {
        withAttachmentCounts: true,
        withAttachments: true,
      },
    );

    expect(page.messages[0].attachmentCount).toBe(1);
    expect(page.messages[0].attachments?.[0].id).toBe("att-in");
    expect(page.messages[1].attachmentCount).toBe(1);
    expect(page.messages[1].attachments?.[0].id).toBe("att-out");
  });

  it("keeps nullable-person campaign sends in inbox scope but not person scope", async () => {
    const db = getDb();
    await db.insert(sentEmails).values({
      id: "campaign-send",
      personId: null,
      fromAddress: "marketing@saasmail.test",
      toAddress: "subscriber@example.com",
      subject: "Newsletter",
      bodyHtml: "<p>Hello</p>",
      bodyText: "Hello",
      status: "sent",
      campaignId: "campaign-1",
      sentAt: 100,
      createdAt: 100,
    });

    const inboxPage = await queryMessages(
      db,
      { isAdmin: true },
      { inboxes: ["marketing@saasmail.test"] },
    );
    expect(inboxPage.messages.map((message) => message.ref.id)).toEqual([
      "campaign-send",
    ]);

    const personPage = await queryMessages(
      db,
      { isAdmin: true },
      { personId: "missing-person" },
    );
    expect(personPage.messages).toEqual([]);
  });

  it("orders equal-second messages by id then kind", async () => {
    const db = getDb();
    await createTestPerson({ id: "tie-person" });
    await db.insert(emails).values({
      id: "same-id",
      personId: "tie-person",
      recipient: "inbox@saasmail.test",
      subject: "Received",
      bodyText: "Received",
      rawHeaders: "{}",
      messageId: "tie-received@example.com",
      isRead: 0,
      receivedAt: 100,
      createdAt: 100,
    });
    await db.insert(sentEmails).values([
      {
        id: "z-id",
        personId: "tie-person",
        fromAddress: "inbox@saasmail.test",
        toAddress: "alice@example.com",
        subject: "Z",
        status: "sent",
        sentAt: 100,
        createdAt: 100,
      },
      {
        id: "same-id",
        personId: "tie-person",
        fromAddress: "inbox@saasmail.test",
        toAddress: "alice@example.com",
        subject: "Same",
        status: "sent",
        sentAt: 100,
        createdAt: 100,
      },
    ]);

    const page = await queryMessages(db, { isAdmin: true }, {});
    expect(page.messages.map((message) => message.ref)).toEqual([
      { kind: "sent", id: "z-id" },
      { kind: "received", id: "same-id" },
      { kind: "sent", id: "same-id" },
    ]);

    const [sent] = await db
      .select()
      .from(sentEmails)
      .where(eq(sentEmails.id, "same-id"));
    expect(sent.id).toBe("same-id");
  });
});
