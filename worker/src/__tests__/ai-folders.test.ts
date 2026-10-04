// docs/specs/SPEC-ai-folders.md: AI filing into described folders.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { MockLanguageModelV4 } from "ai/test";
import { eq, sql } from "drizzle-orm";
import { auditEvents } from "../db/audit-events.schema";
import { mailboxes } from "../db/mailboxes.schema";
import { messageMailboxes } from "../db/message-mailboxes.schema";
import { mailboxMessageState } from "../db/mailbox-message-state.schema";
import {
  buildFilingPrompt,
  filingExcerpt,
  parseFilingAnswer,
} from "../lib/triage/prompt";
import { fileWithAi, type AiFileMessage } from "../lib/triage/ai-file";
import { MAX_AI_FOLDERS } from "../lib/triage/folders";
import { classifyQueueMessage } from "../lib/queue-router";
import { InvalidRuleError, validateRuleActions } from "../lib/rules/validation";
import { evaluateRules } from "../lib/rules/evaluate";
import { rules } from "../db/rules.schema";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";

const INBOX = "support@saasmail.test";
const bindings = env as unknown as CloudflareBindings;

const USAGE = {
  inputTokens: {
    total: 10,
    noCache: 10,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function answering(text: string) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text }],
      finishReason: { unified: "stop" as const, raw: "stop" },
      usage: USAGE,
      warnings: [],
    }),
  });
}

async function addFolder(
  id: string,
  options: {
    name?: string;
    description?: string | null;
    sortOrder?: number;
  } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(mailboxes)
    .values({
      id,
      inbox: INBOX,
      name: options.name ?? id,
      role: null,
      parentId: null,
      sortOrder: options.sortOrder ?? 0,
      aiDescription:
        options.description === undefined
          ? `Mail about ${id}`
          : options.description,
      createdAt: now,
      updatedAt: now,
    });
}

async function folderIds(emailId: string) {
  const rows = await getDb()
    .select({ mailboxId: messageMailboxes.mailboxId })
    .from(messageMailboxes)
    .where(eq(messageMailboxes.messageId, emailId));
  return rows.map((row) => row.mailboxId).sort();
}

const job = (overrides: Partial<AiFileMessage> = {}): AiFileMessage => ({
  type: "ai_file",
  emailId: "e1",
  inbox: INBOX,
  ruleId: "r1",
  archiveWhenFiled: false,
  ...overrides,
});

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
});

describe("the filing prompt", () => {
  const message = {
    from: "alice@example.com",
    subject: "Invoice 42",
    bodyText: "Please find the invoice.\n\nOn Mon, Bob wrote:\n> older text",
    bodyHtml: null,
    attachments: [{ filename: "invoice.pdf", contentType: "application/pdf" }],
  };

  it("lists the folders and quotes the message as data", () => {
    const { instructions, prompt } = buildFilingPrompt({
      folders: [
        { id: "f1", name: "Billing", description: "Invoices and receipts" },
        { id: "f2", name: "Bugs", description: "Bug\nreports" },
      ],
      message,
    });
    expect(instructions).toContain("f1 — Billing — Invoices and receipts");
    expect(instructions).toContain("f2 — Bugs — Bug reports");
    expect(instructions).toContain('{"folders": ["<id>", ...]}');
    expect(prompt).toBe(
      `[BEGIN UNTRUSTED MESSAGE]\n${JSON.stringify({
        from: "alice@example.com",
        subject: "Invoice 42",
        body: "Please find the invoice.",
        attachments: [{ name: "invoice.pdf", type: "application/pdf" }],
      })}\n[END UNTRUSTED MESSAGE]`,
    );
  });

  it("caps the excerpt and falls back to the HTML as text", () => {
    expect(
      filingExcerpt({ ...message, bodyText: "x".repeat(5000) }),
    ).toHaveLength(4000);
    expect(
      filingExcerpt({
        ...message,
        bodyText: "  ",
        bodyHtml: "<p>Hello <b>there</b></p>",
      }),
    ).toContain("Hello there");
  });
});

describe("reading the answer", () => {
  const known = ["a", "b", "c", "d", "e", "f"];

  it("keeps known ids from the first JSON object", () => {
    expect(parseFilingAnswer('{"folders":["a","b"]}', known)).toEqual([
      "a",
      "b",
    ]);
    expect(
      parseFilingAnswer('Sure! {"folders": ["b", "x", "b"]} done {}', known),
    ).toEqual(["b"]);
    expect(
      parseFilingAnswer('{"folders":["a","b","c","d","e","f"]}', known),
    ).toHaveLength(5);
  });

  it("reads anything else as no folder", () => {
    expect(parseFilingAnswer("Billing", known)).toEqual([]);
    expect(parseFilingAnswer('{"folders": "a"}', known)).toEqual([]);
    expect(parseFilingAnswer("{not json", known)).toEqual([]);
    expect(parseFilingAnswer('{"folders":[]}', known)).toEqual([]);
  });
});

describe("filing a message", () => {
  beforeEach(async () => {
    await createTestPerson({ id: "p1", email: "alice@example.com" });
    await createTestEmail({
      id: "e1",
      personId: "p1",
      recipient: INBOX,
      subject: "Invoice 42",
    });
  });

  it("adds the folders the model chose, and nothing else", async () => {
    await addFolder("billing", { sortOrder: 0 });
    await addFolder("bugs", { sortOrder: 1 });
    await addFolder("plain", { description: null });
    const model = answering('{"folders":["billing","plain","nope"]}');

    expect(await fileWithAi(getDb(), bindings, job(), model)).toEqual([
      "billing",
    ]);
    expect(await folderIds("e1")).toEqual(["billing"]);
    // Only the described folders were offered.
    const offered = JSON.stringify(model.doGenerateCalls[0]);
    expect(offered).toContain("billing — billing — Mail about billing");
    expect(offered).not.toContain("plain —");
    expect(model.doGenerateCalls[0]).toMatchObject({
      temperature: 0,
      maxOutputTokens: 200,
    });
    // Routine filing: no audit row.
    expect(await getDb().select().from(auditEvents)).toEqual([]);
  });

  it("archives the message too when asked and it was filed", async () => {
    await addFolder("billing");
    await fileWithAi(
      getDb(),
      bindings,
      job({ archiveWhenFiled: true }),
      answering('{"folders":["billing"]}'),
    );
    const [state] = await getDb()
      .select()
      .from(mailboxMessageState)
      .where(eq(mailboxMessageState.messageId, "e1"));
    expect(state.archivedAt).toEqual(expect.any(Number));
  });

  it("does not archive when the model chose no folder", async () => {
    await addFolder("billing");
    expect(
      await fileWithAi(
        getDb(),
        bindings,
        job({ archiveWhenFiled: true }),
        answering('{"folders":[]}'),
      ),
    ).toEqual([]);
    const states = await getDb().select().from(mailboxMessageState);
    expect(states.every((state) => state.archivedAt === null)).toBe(true);
  });

  it("calls no model without a described folder, or for a message that is gone", async () => {
    const model = answering('{"folders":["billing"]}');
    expect(await fileWithAi(getDb(), bindings, job(), model)).toEqual([]);
    await addFolder("billing");
    expect(
      await fileWithAi(getDb(), bindings, job({ emailId: "missing" }), model),
    ).toEqual([]);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("throws on a model error, for the queue to retry, and changes nothing", async () => {
    await addFolder("billing");
    const failing = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("provider down");
      },
    });
    await expect(
      fileWithAi(getDb(), bindings, job(), failing),
    ).rejects.toThrow();
    expect(await folderIds("e1")).toEqual([]);
  });

  it("is a queue message of its own", () => {
    expect(classifyQueueMessage(job())).toBe("ai_file");
    expect(classifyQueueMessage({ type: "ai_file" })).toBe("unknown");
  });
});

describe("an ai_file rule", () => {
  it("must be scoped to an inbox, alone of its kind, with a described folder", async () => {
    const validate = (inbox: string | null, count = 1) =>
      validateRuleActions(getDb(), {
        inbox,
        actions: Array.from({ length: count }, () => ({
          type: "ai_file" as const,
        })),
      });
    await expect(validate(null)).rejects.toThrow("inbox-scoped");
    await expect(validate(INBOX)).rejects.toMatchObject({
      code: "NO_AI_FOLDERS",
    });
    await addFolder("billing");
    await expect(validate(INBOX, 2)).rejects.toThrow(InvalidRuleError);
    await expect(validate(INBOX)).resolves.toBeUndefined();
  });

  it("queues a filing job when it matches", async () => {
    await addFolder("billing");
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(rules)
      .values({
        id: "r1",
        name: "File",
        inbox: INBOX,
        trigger: "message.received",
        conditions: [],
        actions: [{ type: "ai_file", archiveWhenFiled: true }],
        position: 0,
        stopProcessing: 0,
        enabled: 1,
        matchCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    const sent: unknown[] = [];
    const pending: Promise<unknown>[] = [];
    await evaluateRules(
      getDb(),
      {
        emailId: "e9",
        inbox: INBOX,
        fromAddress: "alice@example.com",
        subject: "Hi",
        bodyText: "hello",
        bodyHtml: null,
        hasAttachments: false,
        spamScore: null,
        headers: {},
      },
      {
        env: {
          ...bindings,
          ANTHROPIC_API_KEY: "test-key",
          EMAIL_QUEUE: {
            send: async (message: unknown) => {
              sent.push(message);
            },
          },
        } as unknown as CloudflareBindings,
        ctx: { waitUntil: (promise) => pending.push(promise) },
      },
    );
    await Promise.all(pending);
    expect(sent).toEqual([
      {
        type: "ai_file",
        emailId: "e9",
        inbox: INBOX,
        ruleId: "r1",
        archiveWhenFiled: true,
      },
    ]);
  });
});

describe("the folder and message routes", () => {
  let apiKey: string;

  beforeEach(async () => {
    ({ apiKey } = await createTestUser());
  });

  it("store a folder's colour and description, trimmed, and clear them", async () => {
    const created = await authFetch("/api/mailboxes", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        inbox: INBOX,
        name: "Billing",
        color: "teal",
        aiDescription: "  Invoices and receipts ",
      }),
    });
    expect(created.status).toBe(200);
    const folder = (await created.json()) as Record<string, unknown>;
    expect(folder).toMatchObject({
      color: "teal",
      aiDescription: "Invoices and receipts",
    });

    const patched = await authFetch(`/api/mailboxes/${folder.id}`, {
      apiKey,
      method: "PATCH",
      body: JSON.stringify({ color: null, aiDescription: "" }),
    });
    expect(await patched.json()).toMatchObject({
      color: null,
      aiDescription: null,
    });

    const listed = await authFetch(
      `/api/mailboxes?inbox=${encodeURIComponent(INBOX)}`,
      { apiKey },
    );
    const { mailboxes: rows } = (await listed.json()) as {
      mailboxes: Record<string, unknown>[];
    };
    expect(rows[0]).toHaveProperty("aiDescription", null);
  });

  it("refuse an unknown colour, and a 31st described folder", async () => {
    const bad = await authFetch("/api/mailboxes", {
      apiKey,
      method: "POST",
      body: JSON.stringify({ inbox: INBOX, name: "X", color: "mauve" }),
    });
    expect(bad.status).toBe(400);

    for (let i = 0; i < MAX_AI_FOLDERS; i++) {
      await addFolder(`f${i}`);
    }
    const tooMany = await authFetch("/api/mailboxes", {
      apiKey,
      method: "POST",
      body: JSON.stringify({
        inbox: INBOX,
        name: "One more",
        aiDescription: "Anything else",
      }),
    });
    expect(tooMany.status).toBe(400);
    expect(await tooMany.json()).toMatchObject({ code: "TOO_MANY_AI_FOLDERS" });
    // Without a description it is just a folder.
    const plain = await authFetch("/api/mailboxes", {
      apiKey,
      method: "POST",
      body: JSON.stringify({ inbox: INBOX, name: "Plain" }),
    });
    expect(plain.status).toBe(200);
  });

  describe("POST /api/messages/ai-file", () => {
    const queue = (env as any).EMAIL_QUEUE;
    let queued: unknown[];

    beforeEach(async () => {
      queued = [];
      (env as any).EMAIL_QUEUE = {
        sendBatch: async (messages: { body: unknown }[]) => {
          queued.push(...messages.map((message) => message.body));
        },
      };
      (env as any).ANTHROPIC_API_KEY = "test-key";
      await createTestPerson({ id: "p1", email: "alice@example.com" });
      await createTestEmail({
        id: "e1",
        personId: "p1",
        recipient: INBOX,
        messageId: "<e1@example.com>",
      });
      await createTestEmail({
        id: "e2",
        personId: "p1",
        recipient: INBOX,
        messageId: "<e2@example.com>",
      });
      await addFolder("billing");
    });

    afterEach(() => {
      (env as any).EMAIL_QUEUE = queue;
      delete (env as any).ANTHROPIC_API_KEY;
    });

    const fileRefs = (refs: string[], key = apiKey) =>
      authFetch("/api/messages/ai-file", {
        apiKey: key,
        method: "POST",
        body: JSON.stringify({ refs }),
      });

    it("queues one job per message, records one audit row, and answers 202", async () => {
      const res = await fileRefs(["received:e1", "received:e2"]);
      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ queued: 2 });
      const sorted = [...(queued as { emailId: string }[])].sort((a, b) =>
        a.emailId.localeCompare(b.emailId),
      );
      expect(sorted).toEqual([
        expect.objectContaining({
          emailId: "e1",
          ruleId: null,
          archiveWhenFiled: false,
        }),
        expect.objectContaining({ emailId: "e2", ruleId: null }),
      ]);
      const events = (await getDb().select().from(auditEvents)).filter(
        (event) => event.action === "mail.ai_file_requested",
      );
      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0].details!)).toMatchObject({ count: 2 });
    });

    it("refuses more than 50 messages and a message the caller cannot see", async () => {
      const many = Array.from({ length: 51 }, (_, i) => `received:x${i}`);
      expect((await fileRefs(many)).status).toBe(400);

      const member = await createTestUser({
        id: "member-1",
        email: "member@example.com",
        role: "member",
      });
      expect((await fileRefs(["received:e1"], member.apiKey)).status).toBe(404);
      expect(queued).toEqual([]);
    });

    it("refuses an inbox without a described folder", async () => {
      await getDb().run(sql`UPDATE mailboxes SET ai_description = NULL`);
      const res = await fileRefs(["received:e1"]);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: "NO_AI_FOLDERS" });
    });
  });
});
