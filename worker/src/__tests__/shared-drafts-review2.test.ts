// Regression tests for the second shared-drafts review, driven by the exact
// payloads the web composer sends (cc: [], bcc: [], no kept list unless a chip
// was removed).
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { applyMigrations, authFetch, cleanDb, getDb } from "./helpers";
import { acct, sys } from "./jmap-ids";
import { drafts } from "../db/drafts.schema";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { users } from "../db/auth.schema";
import { resolveAllowedInboxes } from "../lib/inbox-permissions";
import { parseDraftEmailId, publicDraftEmailId } from "../jmap/public-ids";
import { sendWebDraft } from "../jmap/web-drafts";
import { uploadBlob } from "./jmap-harness";
import {
  INBOX,
  draftCreate,
  jmapCall,
  recordingSender,
  seedAccount,
} from "./jmap-submission-fixtures";

type Responses = [string, Record<string, any>, string][];

describe("shared drafts: second review regressions", () => {
  let authorId: string;
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    ({ authorId, authorApiKey: apiKey } = await seedAccount());
  });

  async function api(path: string, init: RequestInit = {}) {
    const res = await authFetch(path, { apiKey, ...init });
    return { status: res.status, body: (await res.json()) as any };
  }

  async function clientDraft(overrides: Record<string, unknown> = {}) {
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
    return parseDraftEmailId(res[0][1].created.d.id)!;
  }

  async function openDraft(internal: string) {
    const contextKey = `jmap:${internal}`;
    await api("/api/drafts/open-jmap", {
      method: "POST",
      body: JSON.stringify({ contextKey }),
    });
    const draft = (
      await api(`/api/drafts?contextKey=${encodeURIComponent(contextKey)}`)
    ).body.draft;
    return { contextKey, draft };
  }

  /** What ComposeModal's autosave sends after restoring `draft`. */
  function composerSave(draft: any, changes: Record<string, unknown> = {}) {
    return api("/api/drafts", {
      method: "PUT",
      body: JSON.stringify({
        contextKey: draft.contextKey,
        fromAddress: draft.fromAddress ?? "",
        to: draft.toAddress ?? "",
        cc: draft.cc ?? [],
        subject: draft.subject ?? "",
        bodyHtml: draft.bodyHtml ?? "",
        bodyText: draft.bodyText ?? "",
        bcc: draft.bcc ?? [],
        ...changes,
      }),
    });
  }

  function publish(contextKey: string) {
    return api("/api/drafts/publish", {
      method: "POST",
      body: JSON.stringify({ contextKey }),
    });
  }

  async function row(contextKey: string) {
    const [found] = await getDb()
      .select()
      .from(drafts)
      .where(eq(drafts.contextKey, contextKey));
    return found;
  }

  it("#1: the composer's unchanged saves never make a revision, before or after a publish", async () => {
    const internal = await clientDraft();
    const { contextKey, draft } = await openDraft(internal);
    await composerSave(draft);
    expect((await row(contextKey)).dirty).toBe(0);
    expect((await publish(contextKey)).body.status).toBe("unchanged");

    // A real edit publishes once; the saves that follow it don't loop.
    await composerSave(draft, { subject: "Edited" });
    const first = await publish(contextKey);
    expect(first.body.status).toBe("published");
    const after = first.body.draft;
    for (let i = 0; i < 3; i++) {
      await composerSave(after);
      expect((await publish(contextKey)).body.status).toBe("unchanged");
    }
  });

  it("#2: an unchanged save doesn't bring back a draft deleted in a mail client", async () => {
    const internal = await clientDraft();
    const { contextKey, draft } = await openDraft(internal);
    await jmapCall(authorId, [
      [
        "Email/set",
        {
          accountId: acct(authorId),
          destroy: [publicDraftEmailId(internal)],
        },
        "x",
      ],
    ]);
    const reopened = (
      await api(`/api/drafts?contextKey=${encodeURIComponent(contextKey)}`)
    ).body.draft;
    expect(reopened.jmapState).toBe("gone");
    await composerSave(draft);
    expect((await publish(contextKey)).body.status).toBe("gone");
    expect(await getDb().select().from(jmapDrafts)).toEqual([]);
    // Gone is read live, never stored.
    const again = (
      await api(`/api/drafts?contextKey=${encodeURIComponent(contextKey)}`)
    ).body.draft;
    expect(again.jmapState).toBe("gone");
  });

  it("#4: a draft a mail client is still sending is never sent again from the web", async () => {
    const internal = await clientDraft();
    const { contextKey, draft } = await openDraft(internal);
    await composerSave(draft, { subject: "Edited on the web" });
    await getDb()
      .update(jmapDrafts)
      .set({ submitState: "queued" })
      .where(eq(jmapDrafts.id, internal));
    const db = getDb();
    const [user] = await db.select().from(users).where(eq(users.id, authorId));
    const { sender, calls } = recordingSender();
    const outcome = await sendWebDraft(
      db,
      env,
      await resolveAllowedInboxes(db, user),
      user,
      contextKey,
      [],
      sender,
    );
    expect(outcome.status).toBe("gone");
    expect(calls).toHaveLength(0);
  });

  it("#6: a kept choice made on another revision is ignored: every attachment stays", async () => {
    const blob = await uploadBlob(
      authorId,
      apiKey,
      new TextEncoder().encode("csv"),
      "text/csv",
    );
    const internal = await clientDraft({
      attachments: [{ blobId: blob, type: "text/csv", name: "figures.csv" }],
    });
    const { contextKey, draft } = await openDraft(internal);
    // A removal chosen on some other revision lands on this link.
    await composerSave(draft, {
      subject: "Edited",
      keptAttachments: [],
      keptAttachmentsRev: "some-other-revision",
    });
    await publish(contextKey);
    const next = (await row(contextKey)).jmapDraftId!;
    const res = (await jmapCall(authorId, [
      [
        "Email/get",
        {
          accountId: acct(authorId),
          ids: [publicDraftEmailId(next)],
          properties: ["attachments"],
        },
        "g",
      ],
    ])) as Responses;
    expect(res[0][1].list[0].attachments.map((p: any) => p.name)).toEqual([
      "figures.csv",
    ]);
  });

  it("#7: a draft moved to Trash in a mail client is gone, not published back into Drafts", async () => {
    const internal = await clientDraft();
    const { contextKey, draft } = await openDraft(internal);
    await composerSave(draft, { subject: "Edited" });
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
    expect((await publish(contextKey)).body.status).toBe("gone");
    const [trashed] = await getDb()
      .select()
      .from(jmapDrafts)
      .where(eq(jmapDrafts.id, internal));
    expect(trashed.mailboxRole).toBe("trash");
  });

  it("#11: an unedited mail-client draft is sent as it is, not rebuilt", async () => {
    const internal = await clientDraft();
    const { contextKey, draft } = await openDraft(internal);
    await composerSave(draft);
    const db = getDb();
    const [user] = await db.select().from(users).where(eq(users.id, authorId));
    const outcome = await sendWebDraft(
      db,
      env,
      await resolveAllowedInboxes(db, user),
      user,
      contextKey,
      [],
      recordingSender().sender,
    );
    expect(outcome.status).toBe("sent");
    const res = (await jmapCall(authorId, [
      ["EmailSubmission/get", { accountId: acct(authorId) }, "s"],
    ])) as Responses;
    // The submission names the draft's own id: no new revision was made.
    expect(res[0][1].list[0].emailId).toBe(publicDraftEmailId(internal));
  });

  it("keep as a new draft moves a mail-client draft's copy to its own surface", async () => {
    const internal = await clientDraft();
    const { contextKey, draft } = await openDraft(internal);
    const saved = await composerSave(draft, {
      subject: "Something new",
      fresh: true,
    });
    const moved = saved.body.draft.contextKey as string;
    expect(moved).toMatch(/^draft:/);
    expect(await row(contextKey)).toBeUndefined();
    const copy = await row(moved);
    expect(copy.jmapDraftId).toBeNull();
    expect(copy.dirty).toBe(1);
    expect((await publish(moved)).body.status).toBe("published");
    const all = await getDb().select().from(jmapDrafts);
    expect(all.map((d) => d.id)).toContain(internal);
    expect(all).toHaveLength(2);
    // Two drafts, two distinct entries: the mail-client one and the copy.
    const list = (
      await api(`/api/drafts/list?inbox=${encodeURIComponent(INBOX)}`)
    ).body.drafts.map((item: any) => item.contextKey);
    expect(new Set(list).size).toBe(list.length);
    expect(list).toEqual(expect.arrayContaining([moved, `jmap:${internal}`]));
  });

  it("R5: an unedited copy of a draft trashed or deleted in a mail client is gone, not sent", async () => {
    const trashed = await clientDraft();
    const a = await openDraft(trashed);
    await composerSave(a.draft);
    await jmapCall(authorId, [
      [
        "Email/set",
        {
          accountId: acct(authorId),
          update: {
            [publicDraftEmailId(trashed)]: {
              mailboxIds: { [sys(INBOX, "trash")]: true },
            },
          },
        },
        "t",
      ],
    ]);
    const db = getDb();
    const [user] = await db.select().from(users).where(eq(users.id, authorId));
    const allowed = await resolveAllowedInboxes(db, user);
    const { sender, calls } = recordingSender();
    expect(
      (await sendWebDraft(db, env, allowed, user, a.contextKey, [], sender))
        .status,
    ).toBe("gone");

    const deleted = await clientDraft({ subject: "Other" });
    const b = await openDraft(deleted);
    await composerSave(b.draft);
    await jmapCall(authorId, [
      [
        "Email/set",
        {
          accountId: acct(authorId),
          destroy: [publicDraftEmailId(deleted)],
        },
        "x",
      ],
    ]);
    expect(
      (await sendWebDraft(db, env, allowed, user, b.contextKey, [], sender))
        .status,
    ).toBe("gone");
    expect(calls).toHaveLength(0);
  });

  it("a draft moved back out of Trash in a mail client is a draft again", async () => {
    const internal = await clientDraft();
    const { contextKey } = await openDraft(internal);
    const move = (role: "trash" | "drafts") =>
      jmapCall(authorId, [
        [
          "Email/set",
          {
            accountId: acct(authorId),
            update: {
              [publicDraftEmailId(internal)]: {
                mailboxIds: { [sys(INBOX, role)]: true },
              },
            },
          },
          "m",
        ],
      ]);
    const state = async () =>
      (await api(`/api/drafts?contextKey=${encodeURIComponent(contextKey)}`))
        .body.draft.jmapState;
    await move("trash");
    expect(await state()).toBe("gone");
    await move("drafts");
    expect(await state()).toBeNull();
  });

  it("R6: an attachment with a Content-ID is a chip, not a hidden inline part", async () => {
    const blob = await uploadBlob(
      authorId,
      apiKey,
      new TextEncoder().encode("pdf"),
      "application/pdf",
    );
    const internal = await clientDraft({
      attachments: [
        {
          blobId: blob,
          type: "application/pdf",
          name: "contract.pdf",
          disposition: "attachment",
          cid: "contract@x",
        },
      ],
    });
    const { draft } = await openDraft(internal);
    expect(draft.storedAttachments.map((p: any) => p.name)).toEqual([
      "contract.pdf",
    ]);
  });

  it("R1: once a publish applied a removal, a plain save doesn't republish", async () => {
    const blob = await uploadBlob(
      authorId,
      apiKey,
      new TextEncoder().encode("x"),
      "text/plain",
    );
    const internal = await clientDraft({
      attachments: [
        { blobId: blob, type: "text/plain", name: "a.txt" },
        { blobId: blob, type: "text/plain", name: "b.txt" },
      ],
    });
    const { contextKey, draft } = await openDraft(internal);
    const keep = draft.storedAttachments[0].partId;
    await composerSave(draft, {
      keptAttachments: [keep],
      keptAttachmentsRev: draft.storedAttachmentsRev,
    });
    const published = await publish(contextKey);
    expect(published.body.status).toBe("published");
    const after = published.body.draft;
    expect(after.storedAttachments.map((p: any) => p.name)).toEqual(["a.txt"]);
    // The composer forgets the applied removal: its saves carry no kept list.
    for (let i = 0; i < 2; i++) {
      await composerSave(after);
      expect((await publish(contextKey)).body.status).toBe("unchanged");
    }
  });
});
