import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { applyMigrations, cleanDb, getDb } from "./helpers";
import { outboxEmails } from "../db/outbox-emails.schema";
import { suppressions } from "../db/suppressions.schema";
import type { JmapContentRow } from "../jmap/content";
import type {
  EmailSender,
  SendEmailAttachment,
  SendEmailParams,
} from "../lib/email-sender";
import {
  buildSubmissionMessage,
  formatRfc5322Date,
  sendSubmission,
  submissionAttachmentLeaves,
} from "../lib/submit-message";

function contentRow(overrides: Partial<JmapContentRow> = {}): JmapContentRow {
  const leaf = (partId: string, extra: Record<string, unknown>) => ({
    partId,
    charset: null,
    name: null,
    disposition: null,
    cid: null,
    size: 1,
    r2Key: null,
    ...extra,
  });
  return {
    id: "content-1",
    createdBy: "user-1",
    inbox: "mine@saasmail.test",
    fromJson: JSON.stringify([
      { name: "Mine, Team", email: "Mine@SaaSMail.test" },
    ]),
    toJson: JSON.stringify([{ name: "Doe, John", email: "John@Example.com" }]),
    ccJson: JSON.stringify([
      { name: "Jane", email: "jane@example.com" },
      { name: null, email: "ops@example.com" },
    ]),
    bccJson: "[]",
    replyToJson: null,
    subject: "Re: exactly this",
    messageId: "abc123@saasmail.test",
    inReplyToJson: JSON.stringify(["orig@example.com"]),
    referencesJson: JSON.stringify(["root@example.com", "orig@example.com"]),
    sentAt: "2026-09-26T10:00:00+02:00",
    partsJson: JSON.stringify({
      partId: null,
      type: "multipart/mixed",
      subParts: [
        {
          partId: null,
          type: "multipart/alternative",
          subParts: [
            leaf("1", { type: "text/plain", charset: "utf-8" }),
            leaf("2", { type: "text/html", charset: "utf-8" }),
          ],
        },
        leaf("3", {
          type: "image/png",
          name: "logo.png",
          disposition: "inline",
          cid: "logo@mine",
          size: 3,
          r2Key: "jmap-content/user-1/content-1/3",
        }),
        leaf("4", {
          type: "text/plain",
          name: "notes.txt",
          disposition: "attachment",
          r2Key: "jmap-content/user-1/content-1/4",
        }),
      ],
    }),
    textBodyJson: JSON.stringify(["1"]),
    htmlBodyJson: JSON.stringify(["2"]),
    attachmentsJson: JSON.stringify(["3", "4"]),
    bodyValuesJson: JSON.stringify({ "1": "Hello", "2": "<p>Hello</p>" }),
    preview: "Hello",
    threadKey: "c_0123456789abcdef",
    rawR2Key: "jmap-content/user-1/content-1.eml",
    size: 1234,
    createdAt: 100,
    ...overrides,
  } as JmapContentRow;
}

describe("formatRfc5322Date", () => {
  it("keeps the offset written in sentAt", () => {
    expect(formatRfc5322Date("2026-09-26T10:00:00+02:00")).toBe(
      "Sat, 26 Sep 2026 10:00:00 +0200",
    );
    expect(formatRfc5322Date("2026-09-26T08:00:00Z")).toBe(
      "Sat, 26 Sep 2026 08:00:00 +0000",
    );
    expect(formatRfc5322Date("2026-01-05T23:30:00-05:30")).toBe(
      "Mon, 05 Jan 2026 23:30:00 -0530",
    );
  });
});

describe("buildSubmissionMessage", () => {
  const attachments: SendEmailAttachment[] = [
    {
      filename: "logo.png",
      contentType: "image/png",
      content: new Uint8Array([1, 2, 3]),
      contentId: "logo@mine",
      disposition: "inline",
    },
  ];

  it("sends the content exactly", () => {
    const message = buildSubmissionMessage(
      contentRow(),
      { email: "mine@saasmail.test", displayName: "Mine Inbox" },
      attachments,
    );
    expect(message).toEqual({
      fromAddress: "mine@saasmail.test",
      from: '"Mine, Team" <mine@saasmail.test>',
      to: "john@example.com",
      toName: "Doe, John",
      cc: [
        { email: "jane@example.com", name: "Jane" },
        { email: "ops@example.com", name: null },
      ],
      subject: "Re: exactly this",
      html: "<p>Hello</p>",
      text: "Hello",
      headers: {
        "Message-ID": "<abc123@saasmail.test>",
        Date: "Sat, 26 Sep 2026 10:00:00 +0200",
        "In-Reply-To": "<orig@example.com>",
        References: "<root@example.com> <orig@example.com>",
      },
      attachments,
    });
  });

  it("falls back to the identity name, then to a bare address", () => {
    const unnamed = contentRow({
      fromJson: JSON.stringify([{ name: null, email: "mine@saasmail.test" }]),
      inReplyToJson: null,
      referencesJson: null,
      htmlBodyJson: "[]",
    });
    const named = buildSubmissionMessage(
      unnamed,
      { email: "mine@saasmail.test", displayName: "Mine Inbox" },
      [],
    );
    expect(named.from).toBe("Mine Inbox <mine@saasmail.test>");
    expect(named.html).toBe("");
    expect(named.headers["In-Reply-To"]).toBeUndefined();
    expect(named.headers.References).toBeUndefined();
    expect(
      buildSubmissionMessage(
        unnamed,
        { email: "mine@saasmail.test", displayName: null },
        [],
      ).from,
    ).toBe("mine@saasmail.test");
  });

  it("lists attachment leaves in attachments order", () => {
    expect(
      submissionAttachmentLeaves(contentRow()).map((leaf) => leaf.partId),
    ).toEqual(["3", "4"]);
  });
});

describe("sendSubmission", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("is transactional: no suppression filtering, no unsubscribe header", async () => {
    await getDb().insert(suppressions).values({
      id: "sup-1",
      email: "john@example.com",
      reason: "unsubscribe",
      createdAt: 1,
    });
    const calls: SendEmailParams[] = [];
    const sender: EmailSender = {
      provider: "none",
      async send(params) {
        calls.push(params);
        return { id: "prov-1", error: null };
      },
      maxAttachmentBytes: () => 25 * 1024 * 1024,
      maxMessageBytes: () => 25 * 1024 * 1024,
    };
    const message = buildSubmissionMessage(
      contentRow(),
      { email: "mine@saasmail.test", displayName: null },
      [],
    );
    const result = await sendSubmission({
      db: getDb(),
      env,
      sender,
      sentEmailId: "sent-1",
      message,
      bookkeepingOwner: null,
    });
    expect(result.outcome).toBe("sent");
    expect(calls).toHaveLength(1);
    expect(calls[0].to).toBe('"Doe, John" <john@example.com>');
    expect(calls[0].cc).toEqual(["Jane <jane@example.com>", "ops@example.com"]);
    expect(calls[0].html).toBe("<p>Hello</p>");
    expect(calls[0].headers?.["List-Unsubscribe"]).toBeUndefined();
    expect(await getDb().select().from(outboxEmails)).toHaveLength(0);
  });
});
