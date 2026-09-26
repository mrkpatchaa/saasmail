import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { applyMigrations, cleanDb, createTestUser, getDb } from "./helpers";
import { users } from "../db/auth.schema";
import { jmapBlobs } from "../db/jmap-blobs.schema";
import { JMAP_ID_PATTERN, parseUploadBlobId } from "../jmap/public-ids";
import {
  parseDeclaredLength,
  readCappedBody,
  storeUpload,
  uploadMediaType,
  uploadTooLargeProblem,
} from "../jmap/upload";

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

function streamOf(bytes: BodyInit): ReadableStream<Uint8Array> {
  return new Response(bytes).body!;
}

/** env whose R2 `put` always fails. */
function envWithFailingPut(): CloudflareBindings {
  const r2 = new Proxy(env.R2, {
    get(target, prop) {
      if (prop === "put") {
        return async () => {
          throw new Error("r2 down");
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(env, {
    get(target, prop) {
      return prop === "R2" ? r2 : Reflect.get(target, prop);
    },
  }) as CloudflareBindings;
}

async function uploadObjects(userId: string): Promise<string[]> {
  const listed = await env.R2.list({ prefix: `jmap-uploads/${userId}/` });
  return listed.objects.map((object) => object.key);
}

/**
 * cleanDb() only empties D1; R2 objects outlive it, so a test that lists the
 * whole upload prefix would see an earlier test's objects. Wipe it between
 * tests, the same way list-import.test.ts clears its own prefix.
 */
async function clearUploadObjects(): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await env.R2.list({ prefix: "jmap-uploads/", cursor });
    const keys = listed.objects.map((object) => object.key);
    if (keys.length > 0) await env.R2.delete(keys);
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

describe("storeUpload", () => {
  beforeAll(async () => {
    await applyMigrations();
  });
  beforeEach(async () => {
    await cleanDb();
    await clearUploadObjects();
  });

  const base = {
    userId: "aaa-uploader",
    accountId: "aACCOUNT",
    contentType: "text/plain",
    declaredLength: null,
    maxBytes: 8,
    now: 1000,
  };

  it("stores the row first and the bytes under jmap-uploads/<user>/<id>", async () => {
    await createTestUser({ id: "aaa-uploader", email: "uploader@example.com" });
    const result = await storeUpload(getDb(), env, {
      ...base,
      body: streamOf(new TextEncoder().encode("hello")),
    });
    expect(result.tooLargeLimit).toBeNull();
    expect(result.blob).toMatchObject({
      accountId: "aACCOUNT",
      type: "text/plain",
      size: 5,
    });
    expect(result.blob!.blobId).toMatch(JMAP_ID_PATTERN);
    const id = parseUploadBlobId(result.blob!.blobId)!;
    const [row] = await getDb()
      .select()
      .from(jmapBlobs)
      .where(eq(jmapBlobs.id, id));
    expect(row).toMatchObject({
      userId: "aaa-uploader",
      size: 5,
      createdAt: 1000,
      r2Key: `jmap-uploads/aaa-uploader/${id}`,
    });
    const object = await env.R2.get(row.r2Key);
    expect(await object!.text()).toBe("hello");
  });

  it("accepts a zero-byte body", async () => {
    await createTestUser({ id: "aaa-uploader", email: "uploader@example.com" });
    const result = await storeUpload(getDb(), env, {
      ...base,
      body: streamOf(new Uint8Array(0)),
    });
    expect(result.blob).toMatchObject({ size: 0 });
  });

  it("refuses a body over the limit found while reading, and stores nothing", async () => {
    await createTestUser({ id: "aaa-uploader", email: "uploader@example.com" });
    // No declared length: only the read-loop counter can catch this.
    const result = await storeUpload(getDb(), env, {
      ...base,
      body: streamOf(new Uint8Array(9)),
    });
    expect(result).toEqual({ blob: null, tooLargeLimit: 8 });
    expect(await getDb().select().from(jmapBlobs)).toHaveLength(0);
    expect(await uploadObjects("aaa-uploader")).toEqual([]);
  });

  it("refuses a declared length over the limit without reading the body", async () => {
    await createTestUser({ id: "aaa-uploader", email: "uploader@example.com" });
    let pulled = false;
    // highWaterMark 0: the stream only pulls when someone reads it.
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const result = await storeUpload(getDb(), env, {
      ...base,
      declaredLength: 9,
      body,
    });
    expect(result).toEqual({ blob: null, tooLargeLimit: 8 });
    expect(pulled).toBe(false);
  });

  it("drops the row when the R2 write fails", async () => {
    await createTestUser({ id: "aaa-uploader", email: "uploader@example.com" });
    await expect(
      storeUpload(getDb(), envWithFailingPut(), {
        ...base,
        body: streamOf(new TextEncoder().encode("x")),
      }),
    ).rejects.toThrow("r2 down");
    expect(await getDb().select().from(jmapBlobs)).toHaveLength(0);
  });

  it("reads bodies up to exactly the limit", async () => {
    expect(await readCappedBody(streamOf(new Uint8Array(8)), 8)).toHaveLength(
      8,
    );
    expect(await readCappedBody(streamOf(new Uint8Array(9)), 8)).toBeNull();
    expect(await readCappedBody(null, 8)).toHaveLength(0);
  });

  it("normalises the media type and the declared length", () => {
    expect(uploadMediaType("image/png")).toBe("image/png");
    expect(uploadMediaType(" text/plain; charset=utf-8 ")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(uploadMediaType(null)).toBe("application/octet-stream");
    expect(uploadMediaType("")).toBe("application/octet-stream");
    expect(uploadMediaType("text/plain\r\nX-Evil: 1")).toBe(
      "application/octet-stream",
    );
    expect(uploadMediaType("a".repeat(256))).toBe("application/octet-stream");
    expect(parseDeclaredLength("12")).toBe(12);
    expect(parseDeclaredLength(null)).toBeNull();
    expect(parseDeclaredLength("-1")).toBeNull();
    expect(parseDeclaredLength("abc")).toBeNull();
  });

  it("describes the limit in the 413 problem body", async () => {
    const response = uploadTooLargeProblem(8);
    expect(response.status).toBe(413);
    expect(response.headers.get("Content-Type")).toContain(
      "application/problem+json",
    );
    expect(await response.json()).toMatchObject({
      status: 413,
      limit: "maxSizeUpload",
      maxSize: 8,
    });
  });
});
