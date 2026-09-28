import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { applyMigrations, authFetch, cleanDb, getDb } from "./helpers";
import { acct, sys } from "./jmap-ids";
import { drafts } from "../db/drafts.schema";
import { users } from "../db/auth.schema";
import { resolveAllowedInboxes } from "../lib/inbox-permissions";
import { parseDraftEmailId } from "../jmap/public-ids";
import { openJmapDraft, sendWebDraft } from "../jmap/web-drafts";
import {
  INBOX,
  draftCreate,
  jmapCall,
  recordingSender,
  seedAccount,
} from "./jmap-submission-fixtures";

type Responses = [string, Record<string, any>, string][];

describe("shared drafts: sending a web draft through the submission path", () => {
  let authorId: string;
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    ({ authorId, authorApiKey: apiKey } = await seedAccount());
    // The route builds its own sender: the demo one accepts everything.
    (env as any).DEMO_MODE = "1";
  });
  afterEach(() => {
    (env as any).DEMO_MODE = "0";
  });

  function send(
    payload: Record<string, unknown>,
    files: { name: string; type: string; text: string }[] = [],
  ) {
    const fd = new FormData();
    fd.append("payload", JSON.stringify(payload));
    for (const file of files) {
      fd.append(
        "files",
        new File([file.text], file.name, { type: file.type }),
        file.name,
      );
    }
    return authFetch("/api/drafts/send", {
      apiKey,
      method: "POST",
      body: fd,
    });
  }

  async function sentEmails() {
    const res = (await jmapCall(authorId, [
      [
        "Email/query",
        {
          accountId: acct(authorId),
          filter: { inMailbox: sys(INBOX, "sent") },
        },
        "q",
      ],
      [
        "Email/get",
        {
          accountId: acct(authorId),
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
          properties: ["subject", "to", "bcc", "attachments", "keywords"],
        },
        "g",
      ],
      ["EmailSubmission/get", { accountId: acct(authorId) }, "s"],
    ])) as Responses;
    return { emails: res[1][1].list, submissions: res[2][1].list };
  }

  it("sends the composer's draft and files the same Email into Sent", async () => {
    const res = await send(
      {
        contextKey: "draft:s1",
        fromAddress: INBOX,
        to: "alice@example.com",
        subject: "Numbers",
        bodyHtml: "<p>See attached</p><div data-signature>Hello Team</div>",
        bodyText: "See attached",
      },
      [{ name: "notes.txt", type: "text/plain", text: "q3" }],
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "sent" });

    const { emails, submissions } = await sentEmails();
    expect(emails).toEqual([
      expect.objectContaining({
        subject: "Numbers",
        to: [{ name: null, email: "alice@example.com" }],
        keywords: { $seen: true },
        attachments: [expect.objectContaining({ name: "notes.txt" })],
      }),
    ]);
    // The same Email the submission names: the draft was filed into Sent.
    expect(emails[0].id).toMatch(/^D/);
    expect(submissions).toEqual([
      expect.objectContaining({ emailId: emails[0].id, undoStatus: "final" }),
    ]);
    // The working copy is done.
    expect(await getDb().select().from(drafts)).toEqual([]);
  });

  it("a mail-client draft sent from the web keeps its Bcc and every To", async () => {
    const res = (await jmapCall(authorId, [
      [
        "Email/set",
        {
          accountId: acct(authorId),
          create: {
            d: draftCreate({
              to: [
                { name: "Alice", email: "alice@example.com" },
                { name: "Carol", email: "carol@example.com" },
              ],
              cc: [],
              bcc: [{ name: null, email: "boss@example.com" }],
            }),
          },
        },
        "c",
      ],
    ])) as Responses;
    const id = parseDraftEmailId(res[0][1].created.d.id)!;
    const db = getDb();
    const [user] = await db.select().from(users).where(eq(users.id, authorId));
    const allowed = await resolveAllowedInboxes(db, user);
    const contextKey = (await openJmapDraft(db, allowed, authorId, id))!;
    await db
      .update(drafts)
      .set({ subject: "Final numbers", dirty: 1 })
      .where(eq(drafts.contextKey, contextKey));

    const recording = recordingSender();
    const calls = recording.calls;
    // A provider that delivers several To and Bcc (Cloudflare, Resend, Postmark).
    const sender = {
      ...recording.sender,
      recipientSupport: () => ({ multipleTo: true, bcc: true }),
    };
    const outcome = await sendWebDraft(
      db,
      env,
      allowed,
      user,
      contextKey,
      [],
      sender,
    );
    expect(outcome.status).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0].subject).toBe("Final numbers");
    expect(calls[0].to).toContain("alice@example.com");
    expect(calls[0].additionalTo ?? []).toEqual([
      expect.stringContaining("carol@example.com"),
    ]);
    expect(calls[0].bcc ?? []).toEqual([
      expect.stringContaining("boss@example.com"),
    ]);
    (env as any).DEMO_MODE = "0";
    const { emails } = await sentEmails();
    expect(emails[0].bcc).toEqual([{ name: null, email: "boss@example.com" }]);
  });

  it("an inbox without a sender identity falls back to the direct route", async () => {
    const res = await send({
      contextKey: "draft:s2",
      fromAddress: "no-identity@saasmail.test",
      to: "alice@example.com",
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ fallback: true });
  });

  it("an incomplete draft is refused and kept", async () => {
    const res = await send({
      contextKey: "draft:s3",
      fromAddress: INBOX,
      to: "alic",
      subject: "Hi",
      bodyHtml: "<p>Hi</p>",
    });
    expect(res.status).toBe(400);
    expect(await getDb().select().from(drafts)).toHaveLength(1);
    expect((await sentEmails()).submissions).toEqual([]);
  });

  it("a draft sent or deleted from a mail client isn't sent again", async () => {
    await send({
      contextKey: "draft:s4",
      fromAddress: INBOX,
      to: "alice@example.com",
      subject: "First",
      bodyHtml: "<p>1</p>",
    });
    // A new working copy linked to a JMAP draft that is gone meanwhile.
    const created = (await jmapCall(authorId, [
      [
        "Email/set",
        { accountId: acct(authorId), create: { d: draftCreate() } },
        "c",
      ],
    ])) as Responses;
    const id = parseDraftEmailId(created[0][1].created.d.id)!;
    const db = getDb();
    const [user] = await db.select().from(users).where(eq(users.id, authorId));
    const contextKey = (await openJmapDraft(
      db,
      await resolveAllowedInboxes(db, user),
      authorId,
      id,
    ))!;
    await jmapCall(authorId, [
      [
        "Email/set",
        { accountId: acct(authorId), destroy: [created[0][1].created.d.id] },
        "x",
      ],
    ]);
    const res = await send({
      contextKey,
      fromAddress: INBOX,
      to: "alice@example.com",
      subject: "Again",
      bodyHtml: "<p>2</p>",
    });
    expect(res.status).toBe(409);
    expect((await sentEmails()).submissions).toHaveLength(1);
  });
});
