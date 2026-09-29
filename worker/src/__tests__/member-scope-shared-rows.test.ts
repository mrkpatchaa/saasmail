// A conversation or a person can have mail in an inbox the member is granted
// and in one they are not. Reads show only the granted inbox's mail and writes
// touch only it; an admin still sees and changes both.
import { eq, inArray } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { emails } from "../db/emails.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { people } from "../db/people.schema";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestAttachment,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";

const GRANTED = "granted@saasmail.test";
const PRIVATE = "private@saasmail.test";
const T_GRANTED = 1_800_000_000;
const T_PRIVATE = T_GRANTED + 3600;

async function users() {
  const admin = await createTestUser({ id: "scope-admin" });
  const member = await createTestUser({
    id: "scope-member",
    role: "member",
    email: "scope-member@example.com",
  });
  await getDb().insert(inboxPermissions).values({
    userId: member.userId,
    email: GRANTED,
    createdAt: 1,
    createdBy: null,
  });
  return { admin: admin.apiKey, member: member.apiKey };
}

async function email(
  id: string,
  recipient: string,
  at: number,
  opts: { personId: string; conversationId?: string; cc?: string },
) {
  await createTestEmail({
    id,
    personId: opts.personId,
    recipient,
    messageId: `${id}@example.com`,
    conversationId: opts.conversationId ?? null,
    cc: opts.cc ?? null,
  });
  await getDb().update(emails).set({ receivedAt: at }).where(eq(emails.id, id));
}

async function json(path: string, apiKey: string, init: RequestInit = {}) {
  const response = await authFetch(path, { ...init, apiKey });
  expect(response.status, path).toBe(200);
  return (await response.json()) as any;
}

async function unread(ids: string[]) {
  const rows = await getDb()
    .select({ id: emails.id, isRead: emails.isRead })
    .from(emails)
    .where(inArray(emails.id, ids));
  return Object.fromEntries(rows.map((row) => [row.id, row.isRead === 0]));
}

describe("rows shared between a granted and a private inbox", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    await createTestPerson({ id: "p-both", email: "both@example.com" });
  });

  describe("POST /api/conversations/mark-read", () => {
    async function seedConversation() {
      await email("c-granted", GRANTED, T_GRANTED, {
        personId: "p-both",
        conversationId: "conv-shared",
      });
      await email("c-private", PRIVATE, T_PRIVATE, {
        personId: "p-both",
        conversationId: "conv-shared",
      });
    }
    const mark = (apiKey: string) =>
      json("/api/conversations/mark-read", apiKey, {
        method: "POST",
        body: JSON.stringify({ conversationIds: ["conv-shared"] }),
      });

    it("a member marks only the granted inbox's rows read", async () => {
      const { member } = await users();
      await seedConversation();
      expect(await mark(member)).toEqual({ success: true, affected: 1 });
      expect(await unread(["c-granted", "c-private"])).toEqual({
        "c-granted": false,
        "c-private": true,
      });
    });

    it("an admin marks every row read", async () => {
      const { admin } = await users();
      await seedConversation();
      expect(await mark(admin)).toEqual({ success: true, affected: 2 });
      expect(await unread(["c-granted", "c-private"])).toEqual({
        "c-granted": false,
        "c-private": false,
      });
    });
  });

  describe("people reads", () => {
    async function seedPerson() {
      await email("p-granted", GRANTED, T_GRANTED, { personId: "p-both" });
      await email("p-private", PRIVATE, T_PRIVATE, { personId: "p-both" });
      await createTestAttachment({
        id: "att-private",
        emailId: "p-private",
        r2Key: "attachments/private.txt",
      });
      // The denormalized counters span every inbox.
      await getDb()
        .update(people)
        .set({ lastEmailAt: T_PRIVATE, unreadCount: 2, totalCount: 2 })
        .where(eq(people.id, "p-both"));
    }

    function personRow(body: { data: any[] }) {
      const row = body.data.find(
        (item) => item.type === "person" && item.id === "p-both",
      );
      expect(row).toBeDefined();
      return row;
    }

    it("GET /api/people/grouped: a member sees only the granted inbox's address, counts, recency and attachments", async () => {
      const { member, admin } = await users();
      await seedPerson();
      expect(
        personRow(await json("/api/people/grouped", member)),
      ).toMatchObject({
        recipients: [GRANTED],
        recipientCount: 1,
        totalCount: 1,
        unreadCount: 1,
        lastEmailAt: T_GRANTED,
        hasAttachment: 0,
      });
      const adminRow = personRow(await json("/api/people/grouped", admin));
      expect([...adminRow.recipients].sort()).toEqual(
        [GRANTED, PRIVATE].sort(),
      );
      expect(adminRow).toMatchObject({
        recipientCount: 2,
        totalCount: 2,
        unreadCount: 2,
        lastEmailAt: T_PRIVATE,
        hasAttachment: 1,
      });
    });

    it("GET /api/people/grouped?unread=1 and ?recipient=<private>: nothing from the private inbox", async () => {
      const { member } = await users();
      await seedPerson();
      // Only the private row is unread.
      await getDb()
        .update(emails)
        .set({ isRead: 1 })
        .where(eq(emails.id, "p-granted"));
      const unreadOnly = await json("/api/people/grouped?unread=1", member);
      expect(unreadOnly.data).toEqual([]);
      const privateOnly = await json(
        `/api/people/grouped?recipient=${encodeURIComponent(PRIVATE)}`,
        member,
      );
      expect(privateOnly.data).toEqual([]);
    });

    it("GET /api/people/{id}: a member gets counts and recency over the granted inbox only", async () => {
      const { member, admin } = await users();
      await seedPerson();
      expect(await json("/api/people/p-both", member)).toMatchObject({
        id: "p-both",
        lastEmailAt: T_GRANTED,
        unreadCount: 1,
        totalCount: 1,
      });
      expect(await json("/api/people/p-both", admin)).toMatchObject({
        id: "p-both",
        lastEmailAt: T_PRIVATE,
        unreadCount: 2,
        totalCount: 2,
      });
    });

    it("GET /api/people/grouped group rows: participants, CC and attachments of the granted inbox only", async () => {
      const { member, admin } = await users();
      await createTestPerson({ id: "p-secret", email: "secret@example.com" });
      await email("g-granted", GRANTED, T_GRANTED, {
        personId: "p-both",
        conversationId: "conv-g",
        cc: JSON.stringify([{ email: "cc-granted@example.com", name: null }]),
      });
      await email("g-private", PRIVATE, T_PRIVATE, {
        personId: "p-secret",
        conversationId: "conv-g",
        cc: JSON.stringify([{ email: "cc-secret@example.com", name: null }]),
      });
      await createTestAttachment({
        id: "att-g-private",
        emailId: "g-private",
        r2Key: "attachments/g-private.txt",
      });

      const groups = (body: { data: any[] }) =>
        body.data.filter((row) => row.type === "group");
      const [memberGroup, ...rest] = groups(
        await json("/api/people/grouped", member),
      );
      expect(rest).toEqual([]);
      expect(memberGroup).toMatchObject({
        id: "conv-g",
        inbox: GRANTED,
        hasAttachment: 0,
      });
      expect(memberGroup.participants.map((p: any) => p.id)).toEqual([
        "p-both",
      ]);
      expect(memberGroup.ccParticipants.map((p: any) => p.email)).toEqual([
        "cc-granted@example.com",
      ]);

      const adminGroups = groups(await json("/api/people/grouped", admin));
      expect(adminGroups.map((g: any) => g.inbox).sort()).toEqual(
        [GRANTED, PRIVATE].sort(),
      );
      for (const group of adminGroups) {
        expect(group.hasAttachment).toBe(1);
        expect(group.participants.map((p: any) => p.id).sort()).toEqual([
          "p-both",
          "p-secret",
        ]);
      }
    });
  });
});
