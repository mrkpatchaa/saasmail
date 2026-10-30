// docs/test-mail.md: the wait endpoint answers the first matching message to
// a test inbox, with its links and codes, and refuses every other inbox.
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { handleEmail } from "../email-handler";
import { emails } from "../db/emails.schema";
import { rules } from "../db/rules.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import { setWebhookConfig } from "../lib/webhook-config";
import {
  extractCodes,
  extractLinks,
  pruneTestMail,
  waitForTestMail,
  type TestMail,
} from "../lib/test-mail";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";

const TEST_INBOX = "e2e@saasmail.test";
const NORMAL_INBOX = "support@saasmail.test";
const OTHER_TEST_INBOX = "qa@saasmail.test";

async function addInbox(
  email: string,
  purpose: "mail" | "test",
  testRetentionDays: number | null = null,
) {
  const now = Math.floor(Date.now() / 1000);
  await getDb().insert(senderIdentities).values({
    email,
    purpose,
    testRetentionDays,
    createdAt: now,
    updatedAt: now,
  });
}

async function grant(userId: string, ...inboxes: string[]) {
  const now = Math.floor(Date.now() / 1000);
  await getDb()
    .insert(inboxPermissions)
    .values(
      inboxes.map((email) => ({
        userId,
        email,
        createdAt: now,
        createdBy: userId,
      })),
    );
}

let seq = 0;
/** A stored test-inbox message, as the inbound handler writes it. */
async function addMail(opts: {
  recipient?: string;
  detail?: string | null;
  subject?: string;
  text?: string | null;
  html?: string | null;
  receivedAt?: number;
  personId?: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  const id = `mail-${++seq}`;
  await getDb()
    .insert(emails)
    .values({
      id,
      personId: opts.personId ?? "sender-1",
      recipient: opts.recipient ?? TEST_INBOX,
      recipientDetail: opts.detail === undefined ? "run1" : opts.detail,
      subject: opts.subject ?? "Reset your password",
      bodyText: opts.text === undefined ? "Code 482913" : opts.text,
      bodyHtml: opts.html ?? null,
      messageId: `<${id}@example.com>`,
      receivedAt: opts.receivedAt ?? now,
      createdAt: now,
    });
  return id;
}

function waitUrl(params: Record<string, string | number>) {
  const query = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  );
  return `/api/test-mail/wait?${query}`;
}

/** A sleep that only moves the fake clock forward. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
  };
}

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
  await createTestPerson({ id: "sender-1", email: "no-reply@example.com" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractLinks and extractCodes", () => {
  it("decodes &amp; in an href", () => {
    expect(
      extractLinks(
        '<a href="https://example.com/reset?a=1&amp;b=2">Reset</a>',
        null,
      ),
    ).toEqual(["https://example.com/reset?a=1&b=2"]);
  });

  it("takes text URLs, dropping trailing punctuation and duplicates", () => {
    expect(
      extractLinks(
        '<a href="https://example.com/x">x</a> <a href="mailto:a@b.c">m</a>',
        "Go to https://example.com/x. Or (https://example.com/y), ftp://no",
      ),
    ).toEqual(["https://example.com/x", "https://example.com/y"]);
  });

  it("finds whole 4–8 digit runs, not parts of longer ones", () => {
    expect(
      extractCodes("Code 1234", "is 482913, ref 1234567890, id 12"),
    ).toEqual(["1234", "482913"]);
    expect(extractCodes(null, "1234567890")).toEqual([]);
  });
});

describe("GET /api/test-mail/wait", () => {
  it("returns a match with its links and codes", async () => {
    const { apiKey } = await createTestUser({ id: "admin-1" });
    await addInbox(TEST_INBOX, "test");
    const id = await addMail({
      text: "Your code is 482913. Reset at https://example.com/reset?a=1&b=2",
    });

    const res = await authFetch(
      waitUrl({ inbox: TEST_INBOX, detail: "RUN1", since: 0, timeout: 1 }),
      { apiKey },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id,
      inbox: TEST_INBOX,
      detail: "run1",
      from: "no-reply@example.com",
      subject: "Reset your password",
      links: ["https://example.com/reset?a=1&b=2"],
      codes: ["482913"],
    });
  });

  it("filters by detail, subject and since", async () => {
    const { apiKey } = await createTestUser({ id: "admin-1" });
    await addInbox(TEST_INBOX, "test");
    const now = Math.floor(Date.now() / 1000);
    await addMail({ detail: "other", subject: "Welcome" });
    await addMail({
      detail: "run1",
      subject: "Welcome",
      receivedAt: now - 100,
    });
    const wanted = await addMail({ detail: "run1", subject: "Welcome aboard" });
    await addMail({ detail: "run1", subject: "Invoice" });

    const res = await authFetch(
      waitUrl({
        inbox: TEST_INBOX,
        detail: "run1",
        subject: "WELCOME",
        since: now - 10,
        timeout: 1,
      }),
      { apiKey },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as TestMail).id).toBe(wanted);
  });

  it("finds a match behind six near-matches", async () => {
    const { apiKey } = await createTestUser({ id: "admin-1" });
    await addInbox(TEST_INBOX, "test");
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 6; i++) {
      await addMail({ subject: `Newsletter ${i}`, receivedAt: now - 60 + i });
    }
    const wanted = await addMail({ subject: "Your sign-in link" });

    const res = await authFetch(
      waitUrl({
        inbox: TEST_INBOX,
        from: "no-reply@example.com",
        subject: "sign-in",
        since: now - 120,
        timeout: 1,
      }),
      { apiKey },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as TestMail).id).toBe(wanted);
  });

  it("reads the code of an HTML-only message", async () => {
    const { apiKey } = await createTestUser({ id: "admin-1" });
    await addInbox(TEST_INBOX, "test");
    await addMail({
      text: null,
      html: '<p>Your code: <b>739201</b></p><a href="https://example.com/v?t=1&amp;u=2">Verify</a>',
    });

    const res = await authFetch(
      waitUrl({ inbox: TEST_INBOX, since: 0, timeout: 1 }),
      { apiKey },
    );
    const body = (await res.json()) as TestMail;
    expect(body.codes).toContain("739201");
    expect(body.links).toEqual(["https://example.com/v?t=1&u=2"]);
  });

  it("refuses a normal inbox and an inbox outside the member's grant with the same 403", async () => {
    const { apiKey, userId } = await createTestUser({
      id: "member-1",
      role: "member",
    });
    await addInbox(TEST_INBOX, "test");
    await addInbox(NORMAL_INBOX, "mail");
    await addInbox(OTHER_TEST_INBOX, "test");
    await grant(userId, TEST_INBOX, NORMAL_INBOX);

    const normal = await authFetch(
      waitUrl({ inbox: NORMAL_INBOX, since: 0, timeout: 1 }),
      { apiKey },
    );
    const outside = await authFetch(
      waitUrl({ inbox: OTHER_TEST_INBOX, since: 0, timeout: 1 }),
      { apiKey },
    );
    const missing = await authFetch(
      waitUrl({ inbox: "nobody@saasmail.test", since: 0, timeout: 1 }),
      {
        apiKey: (
          await createTestUser({ id: "admin-2", email: "a2@example.com" })
        ).apiKey,
      },
    );
    expect(normal.status).toBe(403);
    expect(outside.status).toBe(403);
    expect(missing.status).toBe(403);
    const bodies = [
      await normal.json(),
      await outside.json(),
      await missing.json(),
    ];
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it("answers 400 on a bad query", async () => {
    const { apiKey } = await createTestUser({ id: "admin-1" });
    for (const params of [
      { inbox: TEST_INBOX },
      { inbox: TEST_INBOX, since: 0, timeout: 31 },
      { inbox: TEST_INBOX, since: 0, timeout: 0 },
      { inbox: "not-an-address", since: 0 },
    ]) {
      const res = await authFetch(waitUrl(params), { apiKey });
      expect(res.status).toBe(400);
    }
  });

  it("answers 204 when nothing arrives before the timeout", async () => {
    const { apiKey } = await createTestUser({ id: "admin-1" });
    await addInbox(TEST_INBOX, "test");
    const res = await authFetch(
      waitUrl({ inbox: TEST_INBOX, detail: "none", since: 0, timeout: 1 }),
      { apiKey },
    );
    expect(res.status).toBe(204);
  });
});

describe("waitForTestMail", () => {
  it("times out with no message after polling at 1 s, then every 2 s", async () => {
    await addInbox(TEST_INBOX, "test");
    const clock = fakeClock();
    const result = await waitForTestMail(
      getDb(),
      { isAdmin: true },
      { inbox: TEST_INBOX, detail: "none", since: 0, timeout: 30 },
      clock,
    );
    expect(result).toEqual({ error: null, message: null });
    const waits = clock.sleep.mock.calls.map(([ms]) => ms);
    expect(waits[0]).toBe(1000);
    expect(waits.slice(1).every((ms) => ms <= 2000)).toBe(true);
    expect(waits.reduce((a, b) => a + b, 0)).toBe(30_000);
    // At most about 20 reads per call.
    expect(waits.length + 1).toBeLessThanOrEqual(20);
  });

  it("returns a message that arrives during the wait", async () => {
    await addInbox(TEST_INBOX, "test");
    const clock = fakeClock();
    let id = "";
    const tick = clock.sleep.getMockImplementation()!;
    clock.sleep.mockImplementation(async (ms: number) => {
      await tick(ms);
      if (clock.sleep.mock.calls.length === 2) id = await addMail({});
    });
    const result = await waitForTestMail(
      getDb(),
      { isAdmin: true },
      { inbox: TEST_INBOX, detail: "run1", since: 0, timeout: 30 },
      clock,
    );
    expect(result.message?.id).toBe(id);
    expect(clock.sleep).toHaveBeenCalledTimes(2);
  });

  it("stops when the signal aborts", async () => {
    await addInbox(TEST_INBOX, "test");
    const controller = new AbortController();
    const clock = fakeClock();
    clock.sleep.mockImplementation(async () => controller.abort());
    const result = await waitForTestMail(
      getDb(),
      { isAdmin: true },
      { inbox: TEST_INBOX, since: 0, timeout: 30 },
      { ...clock, signal: controller.signal },
    );
    expect(result.message).toBeNull();
    expect(clock.sleep).toHaveBeenCalledTimes(1);
  });
});

describe("pruneTestMail", () => {
  it("deletes only test-inbox mail older than its retention", async () => {
    const now = Math.floor(Date.now() / 1000);
    const day = 24 * 60 * 60;
    await addInbox(TEST_INBOX, "test");
    await addInbox(OTHER_TEST_INBOX, "test", 10);
    await addInbox(NORMAL_INBOX, "mail");
    const oldTest = await addMail({ receivedAt: now - 4 * day });
    const freshTest = await addMail({ receivedAt: now - 2 * day });
    const keptByLongerRetention = await addMail({
      recipient: OTHER_TEST_INBOX,
      receivedAt: now - 4 * day,
    });
    const oldNormal = await addMail({
      recipient: NORMAL_INBOX,
      detail: null,
      receivedAt: now - 40 * day,
    });

    expect(await pruneTestMail(getDb(), env as never, now)).toBe(1);
    const left = (await getDb().select({ id: emails.id }).from(emails)).map(
      (r) => r.id,
    );
    expect(left).not.toContain(oldTest);
    expect(left).toEqual(
      expect.arrayContaining([freshTest, keptByLongerRetention, oldNormal]),
    );
  });

  it("works in batches of 200, at most 5 per pass", async () => {
    const now = Math.floor(Date.now() / 1000);
    await addInbox(TEST_INBOX, "test", 1);
    const values = Array.from({ length: 1001 }, (_, i) => ({
      id: `bulk-${i}`,
      personId: "sender-1",
      recipient: TEST_INBOX,
      subject: "old",
      messageId: `<bulk-${i}@example.com>`,
      receivedAt: now - 3 * 24 * 60 * 60,
      createdAt: now,
    }));
    for (let i = 0; i < values.length; i += 8) {
      await getDb()
        .insert(emails)
        .values(values.slice(i, i + 8));
    }

    expect(await pruneTestMail(getDb(), env as never, now)).toBe(1000);
    expect(await getDb().select({ id: emails.id }).from(emails)).toHaveLength(
      1,
    );
    expect(await pruneTestMail(getDb(), env as never, now)).toBe(1);
  });
});

describe("test inbox end to end", () => {
  it("returns plus mail to a member key granted only the test inbox, and fires nothing", async () => {
    const { apiKey, userId } = await createTestUser({
      id: "ci-member",
      role: "member",
    });
    await addInbox(TEST_INBOX, "test");
    await addInbox(NORMAL_INBOX, "mail");
    await grant(userId, TEST_INBOX);
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(rules)
      .values({
        id: "rule-all",
        name: "Every message",
        inbox: null,
        trigger: "message.received",
        conditions: [],
        actions: [{ type: "archive" }] as never,
        position: 0,
        stopProcessing: 0,
        enabled: 1,
        matchCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    await setWebhookConfig(
      getDb(),
      { url: "https://hook.example.com/inbound", secret: null },
      null,
    );
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const since = now - 1;
    const raw = [
      "From: App <no-reply@example.com>",
      "To: e2e+run42@saasmail.test",
      "Subject: Reset your password",
      "Message-ID: <run42@example.com>",
      'Content-Type: multipart/alternative; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Your code is 482913.",
      "--b",
      "Content-Type: text/html; charset=utf-8",
      "",
      '<p>Your code is 482913.</p><a href="https://example.com/reset?a=1&amp;b=2">Reset</a>',
      "--b--",
    ].join("\r\n");
    const waitUntil = vi.fn();
    await handleEmail(
      {
        from: "no-reply@example.com",
        to: "e2e+run42@saasmail.test",
        raw: new Response(raw).body!,
        rawSize: raw.length,
        headers: new Headers(),
        setReject: vi.fn(),
        async forward() {},
        async reply() {},
      } as unknown as ForwardableEmailMessage,
      env as unknown as CloudflareBindings,
      { waitUntil, passThroughOnException() {} } as unknown as ExecutionContext,
    );

    const res = await authFetch(
      waitUrl({ inbox: TEST_INBOX, detail: "run42", since, timeout: 5 }),
      { apiKey },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TestMail;
    expect(body.links).toEqual(["https://example.com/reset?a=1&b=2"]);
    expect(body.codes).toEqual(["482913"]);
    expect(body.detail).toBe("run42");

    // No rule ran, no webhook went out, no notification was fanned out.
    const [rule] = await getDb()
      .select({ matchCount: rules.matchCount })
      .from(rules)
      .where(eq(rules.id, "rule-all"));
    expect(rule.matchCount).toBe(0);
    const state = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM mailbox_message_state WHERE archived_at IS NOT NULL",
    ).first<{ n: number }>();
    expect(state?.n).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();

    const normal = await authFetch(
      waitUrl({ inbox: NORMAL_INBOX, since, timeout: 1 }),
      { apiKey },
    );
    expect(normal.status).toBe(403);
  });
});
