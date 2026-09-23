import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { customerPeople, customers } from "../db/customers.schema";
import { inboxPermissions } from "../db/inbox-permissions.schema";
import {
  linkPeople,
  resolveCustomerScope,
  unlinkPerson,
} from "../lib/customers";
import {
  applyMigrations,
  cleanDb,
  createTestEmail,
  createTestPerson,
  createTestUser,
  getDb,
} from "./helpers";

describe("identity graph service", () => {
  beforeAll(applyMigrations);
  beforeEach(cleanDb);

  it("links, grows, merges smaller into larger, unlinks, and is idempotent", async () => {
    const db = getDb();
    const allowed = { isAdmin: true as const };
    for (const id of ["a", "b", "c", "d", "e", "f", "g"]) {
      await createTestPerson({ id, email: `${id}@example.com` });
    }

    const first = await linkPeople(db, allowed, null, "a", "b");
    expect(first.personIds.sort()).toEqual(["a", "b"]);

    const repeated = await linkPeople(db, allowed, null, "a", "b");
    expect(repeated.customerId).toBe(first.customerId);
    expect(await db.select().from(customers)).toHaveLength(1);

    const second = await linkPeople(db, allowed, null, "c", "d");
    await linkPeople(db, allowed, null, "c", "e");
    expect((await resolveCustomerScope(db, "c")).personIds).toHaveLength(3);

    const merged = await linkPeople(db, allowed, null, "a", "c");
    expect(merged.customerId).toBe(second.customerId);
    expect(new Set(merged.personIds)).toEqual(
      new Set(["a", "b", "c", "d", "e"]),
    );
    expect(await db.select().from(customers)).toHaveLength(1);

    await unlinkPerson(db, allowed, null, "a");
    expect((await resolveCustomerScope(db, "b")).personIds).toHaveLength(4);
    expect((await resolveCustomerScope(db, "a")).customerId).toBeNull();

    const pair = await linkPeople(db, allowed, null, "f", "g");
    expect(pair.customerId).not.toBeNull();
    await unlinkPerson(db, allowed, null, "f");
    expect((await resolveCustomerScope(db, "g")).customerId).toBeNull();
    expect(
      await db
        .select()
        .from(customerPeople)
        .where(eq(customerPeople.personId, "g")),
    ).toHaveLength(0);
  });

  it("returns 404 when either person is outside the existing person visibility rule", async () => {
    const { userId } = await createTestUser({
      id: "identity-member",
      role: "member",
      email: "identity-member@example.com",
    });
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(inboxPermissions).values({
      userId,
      email: "allowed@example.com",
      createdAt: now,
      createdBy: null,
    });
    await createTestPerson({ id: "visible", email: "visible@example.com" });
    await createTestPerson({ id: "hidden", email: "hidden@example.com" });
    await createTestEmail({
      id: "visible-mail",
      personId: "visible",
      recipient: "allowed@example.com",
      messageId: "visible@example.test",
    });
    await createTestEmail({
      id: "hidden-mail",
      personId: "hidden",
      recipient: "denied@example.com",
      messageId: "hidden@example.test",
    });

    await expect(
      linkPeople(
        db,
        { isAdmin: false, inboxes: ["allowed@example.com"] },
        userId,
        "visible",
        "hidden",
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await db.select().from(customers)).toHaveLength(0);
  });
});
