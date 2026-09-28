// Regression tests for the shared-drafts review (C1, C2, R1, R2, R4, O6, O8).
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { applyMigrations, authFetch, cleanDb, getDb } from "./helpers";
import { acct, sys } from "./jmap-ids";
import { drafts } from "../db/drafts.schema";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { users } from "../db/auth.schema";
import { resolveAllowedInboxes } from "../lib/inbox-permissions";
import { parseDraftEmailId, publicDraftEmailId } from "../jmap/public-ids";
import { publishWebDraft, sendWebDraft } from "../jmap/web-drafts";
import { storeUpload } from "../jmap/upload";
import { publicAccountId } from "../jmap/public-ids";
import { uploadBlob } from "./jmap-harness";
import {
  INBOX,
  draftCreate,
  jmapCall,
  recordingSender,
  seedAccount,
} from "./jmap-submission-fixtures";

type Responses = [string, Record<string, any>, string][];

describe("shared drafts: review regressions", () => {
  let authorId: string;
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    ({ authorId, authorApiKey: apiKey } = await seedAccount());
  });
  afterEach(() => {
    (env as any).DEMO_MODE = "0";
  });

  async function api(path: string, init: RequestInit = {}) {
    const res = await authFetch(path, { apiKey, ...init });
    return { status: res.status, body: (await res.json()) as any };
  }

  async function clientDraft(overrides: Record<string, unknown>) {
    const res = (await jmapCall(authorId, [
      [
        "Email/set",
        {
          accountId: acct(authorId),
          create: { d: draftCreate({ cc: [], ...overrides }) },
        },
        "c",
      ],
    ])) as Responses;
    const created = res[0][1].created?.d;
    if (!created) throw new Error(JSON.stringify(res));
    return parseDraftEmailId(created.id)!;
  }

  async function open(internal: string) {
    const contextKey = `jmap:${internal}`;
    const opened = await api("/api/drafts/open-jmap", {
      method: "POST",
      body: JSON.stringify({ contextKey }),
    });
    return { contextKey, opened };
  }

  async function getDraft(contextKey: string) {
    return (
      await api(`/api/drafts?contextKey=${encodeURIComponent(contextKey)}`)
    ).body.draft;
  }

  async function row(contextKey: string) {
    const [found] = await getDb()
      .select()
      .from(drafts)
      .where(eq(drafts.contextKey, contextKey));
    return found;
  }

  async function attachmentNames(internal: string) {
    const res = (await jmapCall(authorId, [
      [
        "Email/get",
        {
          accountId: acct(authorId),
          ids: [publicDraftEmailId(internal)],
          properties: ["attachments"],
        },
        "g",
      ],
    ])) as Responses;
    return res[0][1].list[0].attachments.map((part: any) => part.name);
  }

  it("C1: a kept list chosen on an older revision is ignored; the new one applies after renumbering", async () => {
    const blob = await uploadBlob(
      authorId,
      apiKey,
      new TextEncoder().encode("csv"),
      "text/csv",
    );
    // Text only plus a csv: the csv is part "2"; the web adds an HTML part,
    // so in the next revision it is part "3".
    const internal = await clientDraft({
      attachments: [{ blobId: blob, type: "text/csv", name: "figures.csv" }],
    });
    const { contextKey } = await open(internal);
    const first = await getDraft(contextKey);
    const oldRev = first.storedAttachmentsRev;
    expect(first.storedAttachments.map((p: any) => p.partId)).toEqual(["2"]);

    await api("/api/drafts", {
      method: "PUT",
      body: JSON.stringify({
        contextKey,
        fromAddress: INBOX,
        to: "alice@example.com",
        subject: "Quarterly numbers (edited)",
        bodyHtml: "<p>Numbers attached.</p>",
        bodyText: "Numbers attached.",
      }),
    });
    const published = await api("/api/drafts/publish", {
      method: "POST",
      body: JSON.stringify({ contextKey }),
    });
    const fresh = published.body.draft;
    expect(fresh.storedAttachmentsRev).not.toBe(oldRev);
    expect(fresh.storedAttachments.map((p: any) => p.partId)).toEqual(["3"]);

    // A stale save (the old rev, the old part id) doesn't drop the csv.
    await api("/api/drafts", {
      method: "PUT",
      body: JSON.stringify({
        contextKey,
        fromAddress: INBOX,
        to: "alice@example.com",
        subject: "Quarterly numbers v2",
        bodyHtml: "<p>Numbers attached.</p>",
        bodyText: "Numbers attached.",
        keptAttachments: ["2"],
        keptAttachmentsRev: oldRev,
      }),
    });
    await api("/api/drafts/publish", {
      method: "POST",
      body: JSON.stringify({ contextKey }),
    });
    expect(await attachmentNames((await row(contextKey)).jmapDraftId!)).toEqual(
      ["figures.csv"],
    );
  });

  it("C2: a send racing a publish still sends its own revision, files included", async () => {
    await api("/api/drafts", {
      method: "PUT",
      body: JSON.stringify({
        contextKey: "draft:race",
        fromAddress: INBOX,
        to: "alice@example.com",
        subject: "Race",
        bodyHtml: "<p>race</p>",
      }),
    });
    const db = getDb();
    const [user] = await db.select().from(users).where(eq(users.id, authorId));
    const allowed = await resolveAllowedInboxes(db, user);
    const stored = await storeUpload(db, env, {
      userId: authorId,
      accountId: publicAccountId(authorId),
      contentType: "text/plain",
      declaredLength: 4,
      body: new Response("file" as BodyInit).body,
      maxBytes: 1_000_000,
    });
    const { sender, calls } = recordingSender();
    const [, sent] = await Promise.all([
      publishWebDraft(db, env, allowed, authorId, "draft:race"),
      sendWebDraft(
        db,
        env,
        allowed,
        user,
        "draft:race",
        [
          {
            blobId: stored.blob!.blobId,
            type: "text/plain",
            name: "file.txt",
          },
        ],
        sender,
      ),
    ]);
    expect(sent.status).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(
      (calls[0].attachments ?? []).map((a: { filename: string }) => a.filename),
    ).toEqual(["file.txt"]);
  });

  it("R1: a text-only client draft opens with its text as HTML paragraphs", async () => {
    const internal = await clientDraft({
      bodyValues: { t: { value: "Line one\nline <two>\n\nNew paragraph" } },
    });
    const { contextKey } = await open(internal);
    const draft = await getDraft(contextKey);
    expect(draft.bodyHtml).toBe(
      "<p>Line one<br>line &lt;two&gt;</p><p>New paragraph</p>",
    );
    expect(draft.bodyText).toBe("Line one\nline <two>\n\nNew paragraph");
  });

  it("R2: saving the same values again makes no new revision", async () => {
    const internal = await clientDraft({});
    const { contextKey } = await open(internal);
    const draft = await getDraft(contextKey);
    // What the composer saves right after restoring, unchanged.
    await api("/api/drafts", {
      method: "PUT",
      body: JSON.stringify({
        contextKey,
        fromAddress: draft.fromAddress,
        to: draft.toAddress,
        cc: draft.cc ?? undefined,
        subject: draft.subject,
        bodyHtml: draft.bodyHtml,
        bodyText: draft.bodyText,
        bcc: draft.bcc ?? [],
      }),
    });
    const published = await api("/api/drafts/publish", {
      method: "POST",
      body: JSON.stringify({ contextKey }),
    });
    expect(published.body.status).toBe("unchanged");
    expect((await row(contextKey)).jmapDraftId).toBe(internal);
  });

  it("R4 and O6: a refused send keeps its files in the draft, once, and never the signature", async () => {
    (env as any).DEMO_MODE = "1";
    const many = Array.from({ length: 26 }, (_, i) => `r${i}@example.com`);
    const fd = new FormData();
    fd.append(
      "payload",
      JSON.stringify({
        contextKey: "draft:refused",
        fromAddress: INBOX,
        to: many.join(", "),
        cc: Array.from({ length: 26 }, (_, i) => ({
          email: `c${i}@example.com`,
        })),
        subject: "Too many",
        bodyHtml: "<p>Hello</p>",
        signatureHtml: "<p>Sig</p>",
      }),
    );
    fd.append("files", new File(["abc"], "notes.txt", { type: "text/plain" }));
    const res = await authFetch("/api/drafts/send", {
      apiKey,
      method: "POST",
      body: fd,
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as any;
    // The file is part of the draft now: the composer shows it as stored and
    // doesn't attach it again.
    expect(body.draft.storedAttachments.map((p: any) => p.name)).toEqual([
      "notes.txt",
    ]);
    expect(body.draft.storedAttachmentsRev).toBeTruthy();
    // The working copy never holds the signature, so a retry signs once.
    expect(body.draft.bodyHtml).toBe("<p>Hello</p>");
  });

  it("O8: a draft in Trash isn't opened back into Drafts", async () => {
    const internal = await clientDraft({});
    await jmapCall(authorId, [
      [
        "Email/set",
        {
          accountId: acct(authorId),
          update: {
            [publicDraftEmailId(internal)]: {
              mailboxIds: { [sys(INBOX, "trash")]: true },
            },
          },
        },
        "t",
      ],
    ]);
    const { opened } = await open(internal);
    expect(opened.status).toBe(404);
    const [draft] = await getDb()
      .select()
      .from(jmapDrafts)
      .where(eq(jmapDrafts.id, internal));
    expect(draft.mailboxRole).toBe("trash");
  });
});
