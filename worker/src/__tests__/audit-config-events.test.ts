// docs/specs/SPEC-audit-log.md §3: events for configuration, people and
// credentials.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { auditAuthRequest } from "../auth/audit-hooks";
import { auditEvents } from "../db/audit-events.schema";
import { invitations } from "../db/invitations.schema";
import { senderIdentities } from "../db/sender-identities.schema";
import {
  createMailbox,
  deleteMailbox,
  updateMailbox,
} from "../lib/messages/state";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestUser,
  getDb,
} from "./helpers";

const ADMIN = { isAdmin: true as const };
const INBOX = "support@saasmail.test";

async function events() {
  const rows = await getDb()
    .select()
    .from(auditEvents)
    .orderBy(sql`rowid`);
  return rows.map((row) => ({
    ...row,
    details: row.details ? JSON.parse(row.details) : null,
  }));
}

async function actions() {
  return (await events()).map((row) => row.action).sort();
}

function send(path: string, apiKey: string, method: string, body?: unknown) {
  return authFetch(path, {
    apiKey,
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("audit events for configuration and people", () => {
  let userId: string;
  let apiKey: string;

  beforeAll(async () => {
    await applyMigrations();
  });

  beforeEach(async () => {
    await cleanDb();
    ({ userId, apiKey } = await createTestUser());
  });

  it("records a brand name change with the old and new value, once", async () => {
    await send("/api/admin/settings", apiKey, "PATCH", { brandName: "Acme" });
    // The same value again changes nothing and records nothing.
    await send("/api/admin/settings", apiKey, "PATCH", { brandName: "Acme" });

    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "settings.changed",
      targetType: "setting",
      targetId: "brand_name",
      actorUserId: userId,
      details: { key: "brand_name", from: null, to: "Acme" },
    });
  });

  it("records a webhook change without its secret", async () => {
    const res = await send("/api/webhook", apiKey, "PUT", {
      url: "https://hooks.example.com/in",
      secret: "whsec_do_not_log_me",
    });
    expect(res.status).toBe(200);

    const [row] = await events();
    expect(row.action).toBe("settings.changed");
    expect(row.details).toEqual({
      key: "webhook",
      url: "https://hooks.example.com/in",
      hasSecret: true,
    });
    expect(JSON.stringify(row)).not.toContain("whsec_do_not_log_me");
  });

  it("records an inbox's life: created, changed, access, deleted", async () => {
    const member = await createTestUser({
      id: "audit-member",
      email: "member@example.com",
      role: "member",
    });
    const base = "/api/admin/inboxes";
    const one = `${base}/${encodeURIComponent(INBOX)}`;

    expect(
      (
        await send(base, apiKey, "POST", {
          email: INBOX,
          displayName: "Support",
        })
      ).status,
    ).toBeLessThan(300);
    await send(one, apiKey, "PATCH", {
      forwardTo: "team@elsewhere.test",
      signatureHtml: "<p>Private signature text</p>",
    });
    // A patch that changes nothing is not an event.
    await send(one, apiKey, "PATCH", { forwardTo: "team@elsewhere.test" });
    await send(`${one}/assignments`, apiKey, "PUT", {
      userIds: [member.userId],
    });
    await send(`${one}/assignments`, apiKey, "PUT", { userIds: [] });
    await send(one, apiKey, "DELETE");

    const rows = await events();
    expect(rows.map((row) => row.action)).toEqual([
      "inbox.created",
      "inbox.updated",
      "user.inbox_access_changed",
      "user.inbox_access_changed",
      "inbox.deleted",
    ]);
    expect(rows.every((row) => row.inbox === INBOX)).toBe(true);
    expect(rows[1].details).toEqual({
      forwardTo: { from: null, to: "team@elsewhere.test" },
      signatureHtml: "changed",
    });
    expect(JSON.stringify(rows[1])).not.toContain("Private signature text");
    expect(rows[2].details).toEqual({ added: [member.userId], removed: [] });
    expect(rows[3].details).toEqual({ added: [], removed: [member.userId] });
  });

  it("records folders created, renamed and deleted, not reordered", async () => {
    const now = Math.floor(Date.now() / 1000);
    await getDb()
      .insert(senderIdentities)
      .values({ email: INBOX, createdAt: now, updatedAt: now });
    const folder = await createMailbox(getDb(), ADMIN, userId, {
      inbox: INBOX,
      name: "Invoices",
    });
    await updateMailbox(getDb(), ADMIN, userId, folder.id, { sortOrder: 3 });
    await updateMailbox(getDb(), ADMIN, userId, folder.id, { name: "Bills" });
    await deleteMailbox(getDb(), ADMIN, userId, folder.id);

    const rows = await events();
    expect(rows.map((row) => [row.action, row.summary])).toEqual([
      ["folder.created", `Created the folder 'Invoices' in ${INBOX}`],
      [
        "folder.renamed",
        `Renamed the folder 'Invoices' to 'Bills' in ${INBOX}`,
      ],
      ["folder.deleted", `Deleted the folder 'Bills' in ${INBOX}`],
    ]);
    expect(rows.every((row) => row.targetId === folder.id)).toBe(true);
  });

  it("records rules created, toggled, changed and deleted", async () => {
    const created = await send("/api/admin/rules", apiKey, "POST", {
      name: "Invoices",
      inbox: INBOX,
      conditions: [
        { field: "subject", operator: "contains", value: "invoice" },
      ],
      actions: [{ type: "archive" }],
      position: 0,
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const one = `/api/admin/rules/${id}`;

    await send(one, apiKey, "PATCH", { enabled: false });
    // Already off: nothing changed.
    await send(one, apiKey, "PATCH", { enabled: false });
    await send(one, apiKey, "PATCH", { name: "Invoices 2", enabled: true });
    await send(one, apiKey, "DELETE");

    const rows = await events();
    expect(rows.map((row) => [row.action, row.summary])).toEqual([
      ["rule.created", "Created the rule 'Invoices'"],
      ["rule.toggled", "Turned the rule 'Invoices' off"],
      ["rule.updated", "Changed name, enabled of the rule 'Invoices 2'"],
      ["rule.deleted", "Deleted the rule 'Invoices 2'"],
    ]);
    expect(rows[0].details).toEqual({ enabled: true, actions: ["archive"] });
  });

  it("records invitations, role changes and removals", async () => {
    const other = await createTestUser({
      id: "audit-other",
      email: "other@example.com",
      role: "member",
    });
    expect(
      (
        await send("/api/admin/invites", apiKey, "POST", {
          role: "member",
          email: "new@example.com",
          expiresInDays: 7,
        })
      ).status,
    ).toBe(201);
    await send(`/api/admin/users/${other.userId}/role`, apiKey, "PATCH", {
      role: "admin",
    });
    await send(`/api/admin/users/${other.userId}`, apiKey, "DELETE");

    const rows = await events();
    expect(rows.map((row) => [row.action, row.summary])).toEqual([
      ["user.invited", "Invited new@example.com as member"],
      ["user.role_changed", "Changed other@example.com from member to admin"],
      ["user.removed", "Removed other@example.com (admin)"],
    ]);
  });

  it("records someone joining by invitation as that person", async () => {
    await getDb()
      .insert(invitations)
      .values({
        id: "inv-1",
        token: "tok-1",
        role: "member",
        email: "joiner@example.com",
        expiresAt: new Date(Date.now() + 86_400_000),
        usedBy: null,
        usedAt: null,
        createdBy: userId,
        createdAt: new Date(),
      });
    const res = await authFetch("/api/invites/accept", {
      method: "POST",
      body: JSON.stringify({
        token: "tok-1",
        name: "Joiner",
        email: "joiner@example.com",
        password: "correct horse battery staple",
      }),
    });
    expect(res.status, await res.clone().text()).toBe(200);
    const { userId: joined } = (await res.json()) as { userId: string };

    const [row] = (await events()).filter((e) => e.action === "user.joined");
    expect(row).toMatchObject({
      actorType: "user",
      actorUserId: joined,
      actorLabel: "joiner@example.com",
      channel: "web",
      targetId: joined,
      summary: "joiner@example.com joined as member",
    });
  });

  it("records real sign-ins through better-auth: a wrong password, then the right one", async () => {
    await getDb()
      .insert(invitations)
      .values({
        id: "inv-2",
        token: "tok-2",
        role: "member",
        email: "signer@example.com",
        expiresAt: new Date(Date.now() + 86_400_000),
        usedBy: null,
        usedAt: null,
        createdBy: userId,
        createdAt: new Date(),
      });
    const password = "correct horse battery staple";
    const joined = await authFetch("/api/invites/accept", {
      method: "POST",
      body: JSON.stringify({
        token: "tok-2",
        name: "Signer",
        email: "signer@example.com",
        password,
      }),
    });
    expect(joined.status, await joined.clone().text()).toBe(200);
    const { userId: signerId } = (await joined.json()) as { userId: string };

    const signIn = (attempt: string) =>
      authFetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "cf-connecting-ip": "198.51.100.4" },
        body: JSON.stringify({
          email: "signer@example.com",
          password: attempt,
        }),
      });
    const wrong = await signIn("not the password");
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    const right = await signIn(password);
    expect(right.status, await right.clone().text()).toBe(200);

    const rows = (await events()).filter((row) =>
      row.action.startsWith("auth."),
    );
    expect(rows.map((row) => row.action)).toEqual([
      "auth.sign_in_failed",
      "auth.sign_in",
    ]);
    expect(rows[0]).toMatchObject({
      actorUserId: null,
      channel: "web",
      ip: "198.51.100.4",
      details: { method: "password", email: "signer@example.com" },
    });
    expect(rows[1]).toMatchObject({
      actorType: "user",
      actorUserId: signerId,
      actorLabel: "signer@example.com",
      details: { method: "password" },
    });
    expect(JSON.stringify(rows)).not.toContain(password);
  });

  it("records an API key created and revoked by its prefix", async () => {
    const created = await send("/api/api-keys", apiKey, "POST");
    expect(created.status, await created.clone().text()).toBe(201);
    const { key, prefix } = (await created.json()) as {
      key: string;
      prefix: string;
    };
    // The old key was replaced: use the new one to revoke.
    await send("/api/api-keys", key, "DELETE");

    const rows = await events();
    expect(rows.map((row) => [row.action, row.targetId])).toEqual([
      ["api_key.created", prefix],
      ["api_key.revoked", prefix],
    ]);
    expect(JSON.stringify(rows)).not.toContain(key);
  });
});

describe("auditAuthRequest", () => {
  const jane = { id: "u-jane", email: "jane@acme.com" };

  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("records a sign-in as the person, with the method", async () => {
    await auditAuthRequest(getDb(), {
      path: "/passkey/verify-authentication",
      context: { returned: { ok: true }, newSession: { user: jane } },
    });
    const [row] = await events();
    expect(row).toMatchObject({
      action: "auth.sign_in",
      actorType: "user",
      actorUserId: "u-jane",
      actorLabel: "jane@acme.com",
      summary: "Signed in with a passkey",
      details: { method: "passkey" },
    });
  });

  it("records a failed sign-in with the address tried and nobody as actor", async () => {
    await auditAuthRequest(getDb(), {
      path: "/sign-in/email",
      body: { email: "Jane@Acme.com", password: "wrong" },
      context: { returned: new Error("Invalid email or password") },
    });
    const [row] = await events();
    expect(row).toMatchObject({
      action: "auth.sign_in_failed",
      actorUserId: null,
      summary: "Failed password sign-in for jane@acme.com",
      details: { method: "password", email: "jane@acme.com" },
    });
    expect(JSON.stringify(row)).not.toContain("wrong");
  });

  it("records passkeys added and removed, and OAuth client and consent changes", async () => {
    const session = { user: jane };
    await auditAuthRequest(getDb(), {
      path: "/passkey/verify-registration",
      context: { returned: {}, session },
    });
    await auditAuthRequest(getDb(), {
      path: "/passkey/delete-passkey",
      body: { id: "pk-1" },
      context: { returned: {}, session },
    });
    await auditAuthRequest(getDb(), {
      path: "/oauth2/register",
      context: { returned: { client_id: "c-1", client_name: "Claude" } },
    });
    await auditAuthRequest(getDb(), {
      path: "/oauth2/consent",
      body: { accept: true, scope: "email:read" },
      context: { returned: {}, session },
    });
    // Declining consent grants nothing.
    await auditAuthRequest(getDb(), {
      path: "/oauth2/consent",
      body: { accept: false },
      context: { returned: {}, session },
    });
    await auditAuthRequest(getDb(), {
      path: "/oauth2/delete-consent",
      body: { id: "consent-1" },
      context: { returned: {}, session },
    });

    expect(await actions()).toEqual([
      "oauth.client_registered",
      "oauth.consent_granted",
      "oauth.consent_revoked",
      "user.passkey_added",
      "user.passkey_removed",
    ]);
  });

  it("records nothing for other paths or for a failed change", async () => {
    await auditAuthRequest(getDb(), {
      path: "/get-session",
      context: { returned: {}, session: { user: jane } },
    });
    await auditAuthRequest(getDb(), {
      path: "/passkey/delete-passkey",
      context: { returned: new Error("not found"), session: { user: jane } },
    });
    expect(await events()).toEqual([]);
  });
});
