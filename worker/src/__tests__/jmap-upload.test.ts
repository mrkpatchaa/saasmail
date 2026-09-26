import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, createTestUser, getDb } from "./helpers";
import { users } from "../db/auth.schema";
import { jmapBlobs } from "../db/jmap-blobs.schema";

describe("jmap_blobs table", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
  });

  it("keeps an upload row after its user is deleted, for the reaper", async () => {
    const { userId } = await createTestUser({
      id: "aaa-uploader",
      email: "uploader@example.com",
    });
    await getDb()
      .insert(jmapBlobs)
      .values({
        id: "blob-1",
        userId,
        type: "text/plain",
        size: 5,
        r2Key: `jmap-uploads/${userId}/blob-1`,
        createdAt: 100,
      });
    expect(await getDb().select().from(jmapBlobs)).toHaveLength(1);

    // No foreign key on purpose: a cascade would drop the row and leave its R2
    // object untracked. The age-based reaper deletes both within 24 hours.
    await getDb().delete(users).where(eq(users.id, userId));
    expect(await getDb().select().from(jmapBlobs)).toHaveLength(1);
  });
});
