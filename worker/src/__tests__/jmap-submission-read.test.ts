import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, authFetch, cleanDb, createTestUser } from "./helpers";
import {
  CORE_CAPABILITY,
  MAIL_CAPABILITY,
  SUBMISSION_CAPABILITY,
} from "../jmap/constants";
import { acct } from "./jmap-ids";

describe("JMAP submission capability", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("advertises urn:ietf:params:jmap:submission and accepts it in using", async () => {
    const { userId, apiKey } = await createTestUser({ id: "sub-session" });
    const session = (await (
      await authFetch("/.well-known/jmap", { apiKey })
    ).json()) as Record<string, any>;
    expect(session.capabilities[SUBMISSION_CAPABILITY]).toEqual({});
    expect(
      session.accounts[acct(userId)].accountCapabilities[SUBMISSION_CAPABILITY],
    ).toEqual({ maxDelayedSend: 0, submissionExtensions: {} });
    expect(session.primaryAccounts[SUBMISSION_CAPABILITY]).toBe(acct(userId));

    const echo = await authFetch("/jmap/api", {
      method: "POST",
      apiKey,
      body: JSON.stringify({
        using: [CORE_CAPABILITY, MAIL_CAPABILITY, SUBMISSION_CAPABILITY],
        methodCalls: [["Core/echo", { ok: true }, "c1"]],
      }),
    });
    expect(echo.status).toBe(200);
  });
});
