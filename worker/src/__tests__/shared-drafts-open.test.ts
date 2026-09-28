import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { applyMigrations, authFetch, cleanDb, getDb } from "./helpers";
import { acct, sys } from "./jmap-ids";
import { drafts } from "../db/drafts.schema";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { parseDraftEmailId, publicDraftEmailId } from "../jmap/public-ids";
import { uploadBlob } from "./jmap-harness";
import {
  INBOX,
  draftCreate,
  jmapCall,
  seedAccount,
} from "./jmap-submission-fixtures";

type Responses = [string, Record<string, any>, string][];

const PROPERTIES = [
  "mailboxIds",
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "messageId",
  "inReplyTo",
  "references",
  "attachments",
  "bodyValues",
  "textBody",
  "htmlBody",
];

describe("shared drafts: a mail-client draft in the web", () => {
  let authorId: string;
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    ({ authorId, authorApiKey: apiKey } = await seedAccount());
  });

  /** A draft a JMAP client made, with what the web composer can't show. */
  async function clientDraft(): Promise<string> {
    const blobId = await uploadBlob(
      authorId,
      apiKey,
      new TextEncoder().encode("quarterly figures"),
      "text/csv",
    );
    const res = (await jmapCall(authorId, [
      [
        "Email/set",
        {
          accountId: acct(authorId),
          create: {
            d: draftCreate({
              to: [
                { name: "Alice Example", email: "alice@example.com" },
                { name: "Carol", email: "carol@example.com" },
              ],
              cc: [],
              bcc: [{ name: null, email: "boss@example.com" }],
              replyTo: [{ name: null, email: "replies@saasmail.test" }],
              inReplyTo: ["orig-2@example.com"],
              references: ["root-1@example.com", "orig-2@example.com"],
              attachments: [{ blobId, type: "text/csv", name: "figures.csv" }],
            }),
          },
        },
        "c",
      ],
    ])) as Responses;
    const created = res[0][1].created?.d;
    if (!created) throw new Error(JSON.stringify(res));
    return created.id as string;
  }

  async function email(id: string) {
    const res = (await jmapCall(authorId, [
      [
        "Email/get",
        {
          accountId: acct(authorId),
          ids: [id],
          properties: PROPERTIES,
          fetchAllBodyValues: true,
        },
        "g",
      ],
    ])) as Responses;
    return res[0][1];
  }

  async function api(path: string, init: RequestInit = {}) {
    const res = await authFetch(path, { apiKey, ...init });
    return { status: res.status, body: (await res.json()) as any };
  }

  it("lists the client's draft, opens it once, and reports what it can't show", async () => {
    const id = await clientDraft();
    const internal = parseDraftEmailId(id)!;
    const listed = await api(
      `/api/drafts/list?inbox=${encodeURIComponent(INBOX)}`,
    );
    expect(listed.body.drafts).toEqual([
      expect.objectContaining({
        contextKey: `jmap:${internal}`,
        toAddress: "alice@example.com, carol@example.com",
        subject: "Quarterly numbers",
      }),
    ]);

    const opened = await api("/api/drafts/open-jmap", {
      method: "POST",
      body: JSON.stringify({ contextKey: `jmap:${internal}` }),
    });
    expect(opened).toEqual({
      status: 200,
      body: { contextKey: `jmap:${internal}` },
    });
    const draft = (
      await api(
        `/api/drafts?contextKey=${encodeURIComponent(`jmap:${internal}`)}`,
      )
    ).body.draft;
    expect(draft).toMatchObject({
      fromAddress: INBOX,
      toAddress: "alice@example.com, carol@example.com",
      subject: "Quarterly numbers",
      bodyText: "Numbers attached.",
      jmapState: null,
    });
    // Several To, Bcc and stored attachments show in the composer; only a
    // Reply-To is carried unseen.
    expect(draft.jmapExtras).toEqual(["a Reply-To address"]);
    expect(draft.bcc).toEqual([{ name: null, email: "boss@example.com" }]);
    expect(draft.storedAttachments).toEqual([
      expect.objectContaining({ name: "figures.csv", type: "text/csv" }),
    ]);
    // Opening again reuses the working copy; the list shows it once.
    await api("/api/drafts/open-jmap", {
      method: "POST",
      body: JSON.stringify({ contextKey: `jmap:${internal}` }),
    });
    expect(
      (await getDb().select().from(drafts)).map((row) => row.contextKey),
    ).toEqual([`jmap:${internal}`]);
    const again = await api(
      `/api/drafts/list?inbox=${encodeURIComponent(INBOX)}`,
    );
    expect(again.body.drafts).toHaveLength(1);
  });

  it("a web edit publishes a revision that keeps everything the composer can't show", async () => {
    const id = await clientDraft();
    const internal = parseDraftEmailId(id)!;
    const before = (await email(id)).list[0];
    const contextKey = `jmap:${internal}`;
    await api("/api/drafts/open-jmap", {
      method: "POST",
      body: JSON.stringify({ contextKey }),
    });
    await api("/api/drafts", {
      method: "PUT",
      body: JSON.stringify({
        contextKey,
        fromAddress: INBOX,
        to: "alice@example.com, carol@example.com",
        subject: "Quarterly numbers (final)",
        bodyText: "Final numbers attached.",
      }),
    });
    const published = await api("/api/drafts/publish", {
      method: "POST",
      body: JSON.stringify({ contextKey }),
    });
    expect(published.body).toEqual({ status: "published" });

    const [row] = await getDb()
      .select()
      .from(drafts)
      .where(eq(drafts.contextKey, contextKey));
    const next = publicDraftEmailId(row.jmapDraftId!);
    expect(next).not.toBe(id);
    expect((await email(id)).notFound).toEqual([id]);
    const after = (await email(next)).list[0];
    expect(after.subject).toBe("Quarterly numbers (final)");
    expect(Object.values(after.bodyValues).map((v: any) => v.value)).toContain(
      "Final numbers attached.",
    );
    // Carried through untouched.
    expect(after.to).toEqual(before.to);
    expect(after.bcc).toEqual(before.bcc);
    expect(after.replyTo).toEqual(before.replyTo);
    expect(after.messageId).toEqual(before.messageId);
    expect(after.inReplyTo).toEqual(["orig-2@example.com"]);
    expect(after.references).toEqual([
      "root-1@example.com",
      "orig-2@example.com",
    ]);
    expect(after.attachments).toEqual([
      expect.objectContaining({
        name: "figures.csv",
        type: "text/csv",
        size: before.attachments[0].size,
      }),
    ]);
    expect(after.mailboxIds).toEqual({ [sys(INBOX, "drafts")]: true });
  });

  it("deleting a listed client draft from the web destroys it", async () => {
    const id = await clientDraft();
    const internal = parseDraftEmailId(id)!;
    const res = await authFetch(
      `/api/drafts?contextKey=${encodeURIComponent(`jmap:${internal}`)}`,
      { apiKey, method: "DELETE" },
    );
    expect(res.status).toBe(200);
    expect(await getDb().select().from(jmapDrafts)).toEqual([]);
  });

  it("opening an unknown or foreign draft is a 404", async () => {
    const res = await api("/api/drafts/open-jmap", {
      method: "POST",
      body: JSON.stringify({ contextKey: "jmap:nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("the composer's Bcc and kept attachments decide the next revision", async () => {
    const extra = await uploadBlob(
      authorId,
      apiKey,
      new TextEncoder().encode("appendix"),
      "text/plain",
    );
    const res = (await jmapCall(authorId, [
      [
        "Email/set",
        {
          accountId: acct(authorId),
          create: {
            d: draftCreate({
              cc: [],
              bcc: [{ name: null, email: "boss@example.com" }],
              attachments: [
                { blobId: extra, type: "text/plain", name: "appendix.txt" },
                { blobId: extra, type: "text/plain", name: "copy.txt" },
              ],
            }),
          },
        },
        "c",
      ],
    ])) as Responses;
    const internal = parseDraftEmailId(res[0][1].created.d.id)!;
    const contextKey = `jmap:${internal}`;
    await api("/api/drafts/open-jmap", {
      method: "POST",
      body: JSON.stringify({ contextKey }),
    });
    const opened = (
      await api(`/api/drafts?contextKey=${encodeURIComponent(contextKey)}`)
    ).body.draft;
    expect(
      opened.storedAttachments.map((part: { name: string }) => part.name),
    ).toEqual(["appendix.txt", "copy.txt"]);
    const keep = opened.storedAttachments[0].partId as string;

    await api("/api/drafts", {
      method: "PUT",
      body: JSON.stringify({
        contextKey,
        fromAddress: INBOX,
        to: "alice@example.com",
        subject: "Quarterly numbers",
        bodyText: "Numbers attached.",
        bcc: [{ email: "cfo@example.com", name: "CFO" }],
        keptAttachments: [keep],
      }),
    });
    await api("/api/drafts/publish", {
      method: "POST",
      body: JSON.stringify({ contextKey }),
    });
    const [row] = await getDb()
      .select()
      .from(drafts)
      .where(eq(drafts.contextKey, contextKey));
    const next = (await email(publicDraftEmailId(row.jmapDraftId!))).list[0];
    expect(next.bcc).toEqual([{ name: "CFO", email: "cfo@example.com" }]);
    expect(next.attachments.map((part: { name: string }) => part.name)).toEqual(
      ["appendix.txt"],
    );
    // The new revision holds exactly the kept ones: the choice resets.
    expect(row.attachmentsJson).toBeNull();
    expect(row.dirty).toBe(0);
    const after = (
      await api(`/api/drafts?contextKey=${encodeURIComponent(contextKey)}`)
    ).body.draft;
    expect(
      after.storedAttachments.map((part: { name: string }) => part.name),
    ).toEqual(["appendix.txt"]);
  });
});
