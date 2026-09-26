//
// End-to-end check of JMAP sending against a running saasmail deployment
// (docs/superpowers/specs/2026-09-25-jmap-email-submission-design.md §7).
// It SENDS REAL EMAIL to JMAP_TO (and JMAP_CC when set).
//
//   JMAP_BASE_URL=https://mail.example.com \
//   JMAP_API_KEY=sk_... \
//   JMAP_FROM=hello@example.com \
//   JMAP_TO=privacy@example.com \
//   yarn jmap:e2e
//
// Optional:
//   JMAP_CC                  one Cc recipient
//   JMAP_OLD_ACCOUNT_ID      the user id (the pre-reset JMAP account id); checks it is rejected
//   JMAP_EXPECT_DELIVERY=1   poll JMAP_TO's saasmail inbox (the key's user must be able to read it)
//   JMAP_DELIVERY_TIMEOUT_S  delivery polling budget in seconds (default 120)
//
// Exit codes: 0 every check passed, 1 a check failed, 2 bad configuration.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CORE_CAPABILITY = "urn:ietf:params:jmap:core";
export const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";
export const SUBMISSION_CAPABILITY = "urn:ietf:params:jmap:submission";
export const USING = [CORE_CAPABILITY, MAIL_CAPABILITY, SUBMISSION_CAPABILITY];
export const JMAP_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

/** 1×1 transparent PNG, sent as the inline (cid) image. */
export const PNG_BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);
export const INLINE_CID = "logo@jmap-e2e";

export const EMAIL_GET_PROPERTIES = [
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
  "messageId",
  "inReplyTo",
  "references",
  "sender",
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "sentAt",
  "hasAttachment",
  "preview",
  "bodyStructure",
  "textBody",
  "htmlBody",
  "attachments",
  "bodyValues",
];

/** Everything except the id and the two mutable properties (RFC 8621 §4.1). */
export const IMMUTABLE_EMAIL_PROPERTIES = EMAIL_GET_PROPERTIES.filter(
  (property) => !["id", "mailboxIds", "keywords"].includes(property),
);

export class CheckFailed extends Error {}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readConfig(env) {
  const required = ["JMAP_BASE_URL", "JMAP_API_KEY", "JMAP_FROM", "JMAP_TO"];
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    return {
      error: `Missing required environment variables: ${missing.join(", ")}`,
    };
  }
  let baseUrl;
  try {
    baseUrl = new URL(env.JMAP_BASE_URL.trim()).origin;
  } catch {
    return { error: `JMAP_BASE_URL is not a URL: ${env.JMAP_BASE_URL}` };
  }
  const apiKey = env.JMAP_API_KEY.trim();
  if (!apiKey.startsWith("sk_")) {
    return { error: "JMAP_API_KEY must be a saasmail API key (sk_...)" };
  }
  const timeout = Number(env.JMAP_DELIVERY_TIMEOUT_S ?? "120");
  if (!Number.isInteger(timeout) || timeout <= 0) {
    return { error: "JMAP_DELIVERY_TIMEOUT_S must be a positive integer" };
  }
  return {
    config: {
      baseUrl,
      apiKey,
      from: env.JMAP_FROM.trim().toLowerCase(),
      to: env.JMAP_TO.trim().toLowerCase(),
      cc: env.JMAP_CC?.trim().toLowerCase() || null,
      oldAccountId: env.JMAP_OLD_ACCOUNT_ID?.trim() || null,
      expectDelivery: env.JMAP_EXPECT_DELIVERY === "1",
      deliveryTimeoutSeconds: timeout,
    },
  };
}

/** RFC 6570 level-1 expansion, which is all the JMAP Session templates use. */
export function expandUriTemplate(template, values) {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name) => {
    if (!(name in values)) {
      throw new Error(`No value for {${name}} in URI template ${template}`);
    }
    return encodeURIComponent(String(values[name]));
  });
}

export function resolveUrl(baseUrl, pathOrUrl) {
  return new URL(pathOrUrl, baseUrl).toString();
}

const ID_VALUE_KEYS = new Set([
  "id",
  "accountId",
  "threadId",
  "blobId",
  "parentId",
  "emailId",
  "identityId",
]);
const ID_LIST_KEYS = new Set([
  "ids",
  "notFound",
  "emailIds",
  "threadIds",
  "identityIds",
  "dsnBlobIds",
  "mdnBlobIds",
]);
const ID_MAP_KEYS = new Set(["mailboxIds", "accounts"]);
const SET_RESULT_KEYS = new Set(["created", "updated", "destroyed"]);

/** Every id-bearing value in a JMAP response or Session object. */
export function collectJmapIds(value, into = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectJmapIds(item, into);
    return into;
  }
  if (!isPlainObject(value)) return into;
  for (const [key, child] of Object.entries(value)) {
    if (ID_VALUE_KEYS.has(key) && typeof child === "string") {
      into.push(child);
    } else if (ID_LIST_KEYS.has(key) && Array.isArray(child)) {
      for (const item of child) {
        if (typeof item === "string") into.push(item);
      }
    } else if (ID_MAP_KEYS.has(key) && isPlainObject(child)) {
      into.push(...Object.keys(child));
    } else if (key === "primaryAccounts" && isPlainObject(child)) {
      for (const id of Object.values(child)) {
        if (typeof id === "string") into.push(id);
      }
    } else if (SET_RESULT_KEYS.has(key)) {
      // /changes returns arrays of ids. In /set, "updated" is keyed by id and
      // "created" is keyed by the client's creation id; its values carry "id",
      // which the recursion below collects.
      if (Array.isArray(child)) {
        for (const item of child) {
          if (typeof item === "string") into.push(item);
        }
      } else if (key === "updated" && isPlainObject(child)) {
        into.push(...Object.keys(child));
      }
    }
    collectJmapIds(child, into);
  }
  return into;
}

export function invalidJmapIds(value) {
  return [...new Set(collectJmapIds(value))].filter(
    (id) => !JMAP_ID_PATTERN.test(id),
  );
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function mapStrings(value, transform) {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) {
    return value.map((item) => mapStrings(item, transform));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        mapStrings(child, transform),
      ]),
    );
  }
  return value;
}

/**
 * Body-part blob ids embed the Email id (`P<emailId>_<partId>`), so a draft and
 * its Sent copy name the same part differently. Rewrite an Email's references
 * to itself to a neutral form before comparing two Emails.
 */
export function normalizeSelfReferences(email) {
  const prefix = `P${email.id}_`;
  return mapStrings(email, (text) =>
    text.startsWith(prefix) ? `P<self>_${text.slice(prefix.length)}` : text,
  );
}

export function immutableDifferences(before, after, { ignore = [] } = {}) {
  const left = normalizeSelfReferences(before);
  const right = normalizeSelfReferences(after);
  return IMMUTABLE_EMAIL_PROPERTIES.filter(
    (property) => !ignore.includes(property),
  ).filter(
    (property) =>
      stableStringify(left[property]) !== stableStringify(right[property]),
  );
}

/** System mailbox names are "<Role> — <inbox address>" (docs/jmap.md). */
export function findMailbox(mailboxes, role, inbox) {
  const address = inbox.toLowerCase();
  return (
    mailboxes.find(
      (mailbox) =>
        mailbox.role === role &&
        typeof mailbox.name === "string" &&
        mailbox.name.toLowerCase().endsWith(address),
    ) ?? null
  );
}
