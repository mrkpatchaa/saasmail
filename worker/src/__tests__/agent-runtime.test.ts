import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import {
  applyMigrations,
  authFetch,
  cleanDb,
  createTestUser,
} from "./helpers";

beforeAll(async () => {
  await applyMigrations();
});

beforeEach(async () => {
  await cleanDb();
});

describe("agent session runtime", () => {
  it("keeps session CRUD caller-only", async () => {
    const alice = await createTestUser({
      id: "agent-alice",
      email: "agent-alice@example.com",
    });
    const bob = await createTestUser({
      id: "agent-bob",
      email: "agent-bob@example.com",
    });

    const createdRes = await authFetch("/api/agent/sessions", {
      method: "POST",
      apiKey: alice.apiKey,
      body: JSON.stringify({ title: "Inbox triage" }),
    });
    expect(createdRes.status).toBe(201);

    const created = (await createdRes.json()) as {
      id: string;
      title: string | null;
      instanceName: string;
      archivedAt: number | null;
    };
    expect(created.title).toBe("Inbox triage");
    expect(created.instanceName).toBe(
      `u-${alice.userId}-s-${created.id}`,
    );

    const aliceList = await authFetch("/api/agent/sessions", {
      apiKey: alice.apiKey,
    });
    expect(aliceList.status).toBe(200);
    expect((await aliceList.json()).sessions).toHaveLength(1);

    const bobList = await authFetch("/api/agent/sessions", {
      apiKey: bob.apiKey,
    });
    expect(bobList.status).toBe(200);
    expect((await bobList.json()).sessions).toEqual([]);

    const bobPatch = await authFetch(
      `/api/agent/sessions/${created.id}`,
      {
        method: "PATCH",
        apiKey: bob.apiKey,
        body: JSON.stringify({ title: "Not Bob's session" }),
      },
    );
    expect(bobPatch.status).toBe(404);

    const bobDelete = await authFetch(
      `/api/agent/sessions/${created.id}`,
      { method: "DELETE", apiKey: bob.apiKey },
    );
    expect(bobDelete.status).toBe(404);

    const alicePatch = await authFetch(
      `/api/agent/sessions/${created.id}`,
      {
        method: "PATCH",
        apiKey: alice.apiKey,
        body: JSON.stringify({ title: "Archived triage", archived: true }),
      },
    );
    expect(alicePatch.status).toBe(200);
    const patched = (await alicePatch.json()) as {
      title: string | null;
      archivedAt: number | null;
    };
    expect(patched.title).toBe("Archived triage");
    expect(patched.archivedAt).toEqual(expect.any(Number));

    const aliceDelete = await authFetch(
      `/api/agent/sessions/${created.id}`,
      { method: "DELETE", apiKey: alice.apiKey },
    );
    expect(aliceDelete.status).toBe(200);
    expect(await aliceDelete.json()).toEqual({ success: true });
  });

  it("rejects connecting to another user's agent instance", async () => {
    const alice = await createTestUser({
      id: "agent-connect-alice",
      email: "agent-connect-alice@example.com",
    });
    const bob = await createTestUser({
      id: "agent-connect-bob",
      email: "agent-connect-bob@example.com",
    });

    const bobSessionRes = await authFetch("/api/agent/sessions", {
      method: "POST",
      apiKey: bob.apiKey,
      body: JSON.stringify({ title: "Bob session" }),
    });
    const bobSession = (await bobSessionRes.json()) as {
      instanceName: string;
    };

    const response = await authFetch(
      `/agents/mail-agent/${bobSession.instanceName}`,
      {
        apiKey: alice.apiKey,
        headers: { Upgrade: "websocket" },
      },
    );

    expect(response.status).toBe(403);
  });

  it("rejects unauthenticated agent requests", async () => {
    const alice = await createTestUser({
      id: "agent-unauth-alice",
      email: "agent-unauth-alice@example.com",
    });
    const sessionRes = await authFetch("/api/agent/sessions", {
      method: "POST",
      apiKey: alice.apiKey,
      body: JSON.stringify({ title: "Private" }),
    });
    const session = (await sessionRes.json()) as { instanceName: string };

    const response = await exports.default.fetch(
      `http://localhost/agents/mail-agent/${session.instanceName}`,
    );

    expect(response.status).toBe(401);
  });
});
