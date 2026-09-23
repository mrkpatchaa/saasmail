import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { AllowedInboxes } from "../lib/inbox-permissions";
import { serializeMessageRef } from "../lib/messages/types";
import {
  CORE_CAPABILITY,
  MAIL_CAPABILITY,
  MAX_CALLS_IN_REQUEST,
  MAX_OBJECTS_IN_GET,
  MAX_SIZE_REQUEST,
} from "./constants";
import {
  emailGet,
  emailQuery,
  jmapThreadId,
  visibleMessagesForThreads,
  type JmapMethodError,
} from "./emails";
import { listJmapMailboxes, listUsableIdentities } from "./mailboxes";
import { opaqueState } from "./state";

export type MethodResult =
  | { ok: true; name: string; result: Record<string, unknown> }
  | { ok: false; error: Record<string, unknown> };

function methodError(
  type: string,
  description?: string,
  properties?: string[],
): MethodResult {
  return {
    ok: false,
    error: {
      type,
      ...(description ? { description } : {}),
      ...(properties ? { properties } : {}),
    },
  };
}

function accountError(accountId: unknown, userId: string): MethodResult | null {
  if (typeof accountId !== "string" || accountId !== userId) {
    return methodError("accountNotFound");
  }
  return null;
}

function positionLimit(
  args: Record<string, unknown>,
): { position: number; limit: number } | null {
  const position = args.position === undefined ? 0 : args.position;
  const limit = args.limit === undefined ? Number.MAX_SAFE_INTEGER : args.limit;
  if (
    typeof position !== "number" ||
    !Number.isInteger(position) ||
    position < 0 ||
    typeof limit !== "number" ||
    !Number.isInteger(limit) ||
    limit < 0
  ) {
    return null;
  }
  return { position, limit };
}

function filterProperties(
  object: Record<string, unknown>,
  properties: unknown,
): Record<string, unknown> | null {
  if (properties === undefined || properties === null) return object;
  if (
    !Array.isArray(properties) ||
    !properties.every((property) => typeof property === "string")
  ) {
    return null;
  }
  const result: Record<string, unknown> = { id: object.id };
  for (const property of properties as string[]) {
    if (property in object) result[property] = object[property];
  }
  return result;
}

function identityId(email: string): string {
  const bytes = new TextEncoder().encode(email.toLowerCase());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `idn_${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

export async function makeSession(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  user: any,
): Promise<Record<string, unknown>> {
  const identities = await listUsableIdentities(db, allowed);
  const state = await opaqueState(
    identities.map((identity) => [identity.email, identity.updatedAt]),
  );

  return {
    capabilities: {
      [CORE_CAPABILITY]: {
        maxSizeUpload: 0,
        maxConcurrentUpload: 0,
        maxSizeRequest: MAX_SIZE_REQUEST,
        maxConcurrentRequests: 4,
        maxCallsInRequest: MAX_CALLS_IN_REQUEST,
        maxObjectsInGet: MAX_OBJECTS_IN_GET,
        maxObjectsInSet: 0,
        collationAlgorithms: ["i;ascii-casemap"],
      },
      [MAIL_CAPABILITY]: {},
    },
    accounts: {
      [user.id]: {
        name: user.name || user.email || user.id,
        isPersonal: true,
        isReadOnly: true,
        accountCapabilities: {
          [MAIL_CAPABILITY]: {
            maxMailboxesPerEmail: null,
            maxMailboxDepth: null,
            maxSizeMailboxName: 255,
            maxSizeAttachmentsPerEmail: 0,
            emailQuerySortOptions: ["receivedAt"],
            mayCreateTopLevelMailbox: false,
          },
        },
      },
    },
    primaryAccounts: {
      [MAIL_CAPABILITY]: user.id,
    },
    username: user.email ?? user.id,
    apiUrl: "/jmap/api",
    downloadUrl: "/jmap/download/{accountId}/{blobId}/{name}?type={type}",
    uploadUrl: "",
    eventSourceUrl: "",
    state,
  };
}

async function mailboxGet(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  args: Record<string, unknown>,
): Promise<MethodResult> {
  const account = accountError(args.accountId, userId);
  if (account) return account;
  const ids = args.ids;
  if (
    ids !== undefined &&
    ids !== null &&
    (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
  ) {
    return methodError("invalidArguments", undefined, ["ids"]);
  }
  if (Array.isArray(ids) && ids.length > MAX_OBJECTS_IN_GET) {
    return methodError("invalidArguments", undefined, ["ids"]);
  }

  const all = await listJmapMailboxes(db, allowed, userId);
  const byId = new Map(
    all.list.map((mailbox) => [mailbox.id as string, mailbox]),
  );
  const requested =
    ids === undefined || ids === null
      ? all.list.map((mailbox) => mailbox.id as string)
      : (ids as string[]);
  if (requested.length > MAX_OBJECTS_IN_GET) {
    return methodError(
      "invalidArguments",
      `Mailbox/get exceeds maxObjectsInGet (${MAX_OBJECTS_IN_GET})`,
    );
  }

  const list: Record<string, unknown>[] = [];
  const notFound: string[] = [];
  for (const id of requested) {
    const mailbox = byId.get(id);
    if (!mailbox) {
      notFound.push(id);
      continue;
    }
    const selected = filterProperties(mailbox, args.properties);
    if (!selected)
      return methodError("invalidArguments", undefined, ["properties"]);
    list.push(selected);
  }

  return {
    ok: true,
    name: "Mailbox/get",
    result: {
      accountId: userId,
      state: all.state,
      list,
      notFound,
    },
  };
}

async function mailboxQuery(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  args: Record<string, unknown>,
): Promise<MethodResult> {
  const account = accountError(args.accountId, userId);
  if (account) return account;
  if (args.filter !== undefined && args.filter !== null) {
    return methodError("invalidArguments", undefined, ["filter"]);
  }
  if (args.sort !== undefined && args.sort !== null) {
    return methodError("unsupportedSort");
  }
  const window = positionLimit(args);
  if (!window)
    return methodError("invalidArguments", undefined, ["position", "limit"]);

  const all = await listJmapMailboxes(db, allowed, userId);
  const ids = all.list.map((mailbox) => mailbox.id as string);
  return {
    ok: true,
    name: "Mailbox/query",
    result: {
      accountId: userId,
      queryState: all.state,
      canCalculateChanges: false,
      position: window.position,
      ids: ids.slice(window.position, window.position + window.limit),
      total: ids.length,
    },
  };
}

async function threadGet(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  args: Record<string, unknown>,
): Promise<MethodResult> {
  const account = accountError(args.accountId, userId);
  if (account) return account;
  const ids = args.ids;
  if (
    ids !== undefined &&
    ids !== null &&
    (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
  ) {
    return methodError("invalidArguments", undefined, ["ids"]);
  }
  if (Array.isArray(ids) && ids.length > MAX_OBJECTS_IN_GET) {
    return methodError("invalidArguments", undefined, ["ids"]);
  }

  const messages = await visibleMessagesForThreads(db, allowed, userId);
  const grouped = new Map<string, string[]>();
  for (const message of messages) {
    const key = jmapThreadId(message);
    const current = grouped.get(key) ?? [];
    current.push(serializeMessageRef(message.ref));
    grouped.set(key, current);
  }

  const requested =
    ids === undefined || ids === null ? [...grouped.keys()] : (ids as string[]);
  if (requested.length > MAX_OBJECTS_IN_GET) {
    return methodError(
      "invalidArguments",
      `Thread/get exceeds maxObjectsInGet (${MAX_OBJECTS_IN_GET})`,
    );
  }

  const list: Record<string, unknown>[] = [];
  const notFound: string[] = [];
  for (const id of requested) {
    const emailIds = grouped.get(id);
    if (!emailIds) {
      notFound.push(id);
      continue;
    }
    const thread = filterProperties({ id, emailIds }, args.properties);
    if (!thread)
      return methodError("invalidArguments", undefined, ["properties"]);
    list.push(thread);
  }

  return {
    ok: true,
    name: "Thread/get",
    result: {
      accountId: userId,
      state: await opaqueState(
        [...grouped.entries()].map(([id, emailIds]) => [id, emailIds]),
      ),
      list,
      notFound,
    },
  };
}

async function identityGet(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  userId: string,
  args: Record<string, unknown>,
): Promise<MethodResult> {
  const account = accountError(args.accountId, userId);
  if (account) return account;
  const ids = args.ids;
  if (
    ids !== undefined &&
    ids !== null &&
    (!Array.isArray(ids) || !ids.every((id) => typeof id === "string"))
  ) {
    return methodError("invalidArguments", undefined, ["ids"]);
  }
  if (Array.isArray(ids) && ids.length > MAX_OBJECTS_IN_GET) {
    return methodError("invalidArguments", undefined, ["ids"]);
  }

  const rows = await listUsableIdentities(db, allowed);
  const all = rows.map((row) => ({
    id: identityId(row.email),
    name: row.displayName ?? row.email,
    email: row.email,
    replyTo: null,
    bcc: null,
    textSignature: "",
    htmlSignature: row.signatureHtml ?? "",
    mayDelete: false,
  }));
  const byId = new Map(all.map((identity) => [identity.id, identity]));
  const requested =
    ids === undefined || ids === null
      ? all.map((identity) => identity.id)
      : (ids as string[]);
  const list: Record<string, unknown>[] = [];
  const notFound: string[] = [];
  for (const id of requested) {
    const identity = byId.get(id);
    if (!identity) {
      notFound.push(id);
      continue;
    }
    const selected = filterProperties(identity, args.properties);
    if (!selected)
      return methodError("invalidArguments", undefined, ["properties"]);
    list.push(selected);
  }

  return {
    ok: true,
    name: "Identity/get",
    result: {
      accountId: userId,
      state: await opaqueState(rows.map((row) => [row.email, row.updatedAt])),
      list,
      notFound,
    },
  };
}

export async function executeMethod(
  db: DrizzleD1Database<any>,
  allowed: AllowedInboxes,
  user: any,
  name: string,
  args: Record<string, unknown>,
): Promise<MethodResult> {
  if (name === "Core/echo") {
    return { ok: true, name, result: args };
  }

  if (/\/(changes|queryChanges)$/.test(name)) {
    const type = name.split("/")[0];
    if (["Mailbox", "Email", "Thread", "Identity"].includes(type)) {
      const account = accountError(args.accountId, user.id);
      if (account) return account;
      return methodError("cannotCalculateChanges");
    }
  }

  if (name === "Mailbox/get") return mailboxGet(db, allowed, user.id, args);
  if (name === "Mailbox/query") return mailboxQuery(db, allowed, user.id, args);
  if (name === "Email/get") {
    const account = accountError(args.accountId, user.id);
    if (account) return account;
    const result = await emailGet(db, allowed, user.id, user.id, args);
    const error = result as JmapMethodError;
    if (typeof error.type === "string") {
      return methodError(error.type, error.description, error.properties);
    }
    return { ok: true, name, result };
  }
  if (name === "Email/query") {
    const account = accountError(args.accountId, user.id);
    if (account) return account;
    const result = await emailQuery(db, allowed, user.id, user.id, args);
    const error = result as JmapMethodError;
    if (typeof error.type === "string") {
      return methodError(error.type, error.description, error.properties);
    }
    return { ok: true, name, result };
  }
  if (name === "Thread/get") return threadGet(db, allowed, user.id, args);
  if (name === "Identity/get") return identityGet(db, allowed, user.id, args);

  return methodError("unknownMethod");
}
