// docs/specs/SPEC-backups.md: the restore script, against a stubbed wrangler.
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  literal,
  main,
  parseArgs,
  pieces,
  planSql,
  readManifest,
  readRows,
  verifyFiles,
} from "./restore-backup.mjs";

const KEY = "ab".repeat(32);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function encrypt(bytes) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(KEY, "hex"), iv);
  const sealed = Buffer.concat([
    cipher.update(bytes),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(12 + sealed.length);
  return Buffer.concat([length, iv, sealed]);
}

/** A backup on disk: users, then people (which a mailbox row references). */
function fixture({
  encrypted = false,
  lastMigration = "0083_backup_runs",
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), "backup-fixture-"));
  const tables = {
    users: [{ id: "u1", email: "admin@example.com", name: "It's me" }],
    people: [
      { id: "p1", email: "a@example.com", unread_count: 0, note: null },
      {
        id: "p2",
        email: "b@example.com",
        unread_count: 2,
        note: "x".repeat(70_000),
      },
    ],
  };
  const entries = Object.entries(tables).map(([name, rows]) => {
    // Two gzip members, as a backup written in steps has.
    const half = Math.ceil(rows.length / 2);
    const members = [rows.slice(0, half), rows.slice(half)].map((chunk) => {
      const gz = gzipSync(
        chunk.map((row) => `${JSON.stringify(row)}\n`).join(""),
      );
      return encrypted ? encrypt(gz) : gz;
    });
    const bytes = Buffer.concat(members);
    const file = `${name}.ndjson.gz${encrypted ? ".enc" : ""}`;
    writeFileSync(join(dir, file), bytes);
    return {
      name,
      file,
      rows: rows.length,
      bytes: bytes.length,
      parts: [{ bytes: bytes.length, sha256: sha256(bytes) }],
      columns: Object.keys(rows[0]),
      primaryKey: ["id"],
    };
  });
  const manifest = {
    format: 1,
    app: "saasmail",
    startedAt: 1_790_000_000,
    finishedAt: 1_790_000_100,
    lastMigration,
    compression: "gzip",
    encryption: encrypted ? "aes-256-gcm-frames" : null,
    tables: entries,
    excluded: ["sessions"],
    r2Prefixes: ["attachments/"],
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  writeFileSync(join(dir, "manifest.json"), bytes);
  writeFileSync(
    join(dir, "manifest.sha256"),
    `${sha256(bytes)}  manifest.json\n`,
  );
  return dir;
}

/** wrangler, answering the two queries and recording file loads. */
function stubWrangler({ lastMigration = "0084_later", columns } = {}) {
  const calls = [];
  const known = columns ?? {
    users: ["id", "email", "name"],
    people: ["id", "email", "unread_count", "note", "added_later"],
  };
  const wrangler = (args) => {
    calls.push(args);
    const command = args[args.indexOf("--command") + 1];
    if (args.includes("--file")) return "";
    if (command.startsWith("SELECT name FROM d1_migrations")) {
      return JSON.stringify([
        { results: lastMigration ? [{ name: lastMigration }] : [] },
      ]);
    }
    const names = [...command.matchAll(/table_info\("([^"]+)"\)/g)].map(
      (m) => m[1],
    );
    return JSON.stringify(
      names.map((name) => ({
        results: (known[name] ?? []).map((column) => ({ name: column })),
      })),
    );
  };
  return { wrangler, calls };
}

describe("restore-backup", () => {
  it("reads and checks a backup", () => {
    const dir = fixture();
    const manifest = readManifest(dir);
    expect(() => verifyFiles(dir, manifest)).not.toThrow();
    const rows = readRows(dir, manifest.tables[1], manifest, null);
    expect(rows.map((row) => row.id)).toEqual(["p1", "p2"]);

    const tampered = Buffer.from(readFileSync(join(dir, "people.ndjson.gz")));
    tampered[tampered.length - 1] ^= 1;
    writeFileSync(join(dir, "people.ndjson.gz"), tampered);
    expect(() => verifyFiles(dir, manifest)).toThrow("does not match its hash");
  });

  it("decrypts an encrypted backup, and needs its key", () => {
    const dir = fixture({ encrypted: true });
    const manifest = readManifest(dir);
    expect(readRows(dir, manifest.tables[0], manifest, KEY)[0].name).toBe(
      "It's me",
    );
    expect(() => readRows(dir, manifest.tables[0], manifest, null)).toThrow(
      "--key",
    );
  });

  it("builds the SQL: empty children first, fill parents first, long values in pieces", () => {
    const dir = fixture();
    const manifest = readManifest(dir);
    const data = new Map(
      manifest.tables.map((table) => [
        table.name,
        readRows(dir, table, manifest, null),
      ]),
    );
    const { files, warnings } = planSql(
      manifest,
      data,
      new Map([
        ["users", new Set(["id", "email"])],
        ["people", new Set(["id", "email", "unread_count", "note"])],
      ]),
    );
    expect(files[0]).toBe(
      'PRAGMA defer_foreign_keys = ON;\nDELETE FROM "people";\nDELETE FROM "users";\n',
    );
    const load = files.slice(1).join("");
    expect(load.indexOf('INSERT INTO "users"')).toBeLessThan(
      load.indexOf('INSERT INTO "people"'),
    );
    expect(load).toContain(
      `INSERT INTO "users" ("id", "email") VALUES ('u1', 'admin@example.com');`,
    );
    expect(warnings).toContain("users.name: not in the target, skipped");
    // The 70,000-character note: inserted empty, then appended.
    expect(load).toContain(`('p2', 'b@example.com', 2, '')`);
    const appends =
      load.match(/UPDATE "people" SET "note" = "note" \|\| '/g) ?? [];
    expect(appends).toHaveLength(5);
    for (const statement of load.split("\n")) {
      expect(statement.length).toBeLessThan(100_000);
    }
  });

  it("quotes literals and never splits a surrogate pair", () => {
    expect(literal("it's")).toBe("'it''s'");
    expect(literal(null)).toBe("NULL");
    expect(literal(3)).toBe("3");
    expect(literal(Buffer.from([1, 255]))).toBe("X'01ff'");
    const text = "ab😀cd";
    expect(pieces(text, 3)).toEqual(["ab", "😀c", "d"]);
    expect(pieces(text, 3).join("")).toBe(text);
  });

  it("refuses a target older than the backup", async () => {
    const dir = fixture({ lastMigration: "0083_backup_runs" });
    const { wrangler, calls } = stubWrangler({
      lastMigration: "0080_spam_filter",
    });
    await expect(
      main(["--from", dir, "--database", "saasmail", "--yes"], {
        wrangler,
        log: () => {},
      }),
    ).rejects.toThrow("run yarn db:migrate:prod");
    expect(calls.some((args) => args.includes("--file"))).toBe(false);
  });

  it("loads only what --tables names, and --dry-run loads nothing", async () => {
    const dir = fixture();
    const dry = stubWrangler();
    const lines = [];
    const result = await main(
      [
        "--from",
        dir,
        "--database",
        "saasmail",
        "--tables",
        "people",
        "--dry-run",
      ],
      { wrangler: dry.wrangler, log: (line) => lines.push(line) },
    );
    expect(result.dryRun).toBe(true);
    expect(dry.calls.some((args) => args.includes("--file"))).toBe(false);
    expect(result.plan.tables.map((table) => table.name)).toEqual(["people"]);
    // Some tables only: nothing deleted (a delete would cascade), rows
    // written over by primary key.
    const sql = result.paths.map((path) => readFileSync(path, "utf8")).join("");
    expect(sql).not.toContain("DELETE FROM");
    expect(sql).not.toContain('"users"');
    expect(sql).toContain(
      'ON CONFLICT ("id") DO UPDATE SET "email" = excluded."email", "unread_count" = excluded."unread_count", "note" = excluded."note";',
    );
    expect(lines.join("\n")).toContain("people: 2 rows");

    const real = stubWrangler();
    const loaded = await main(
      ["--from", dir, "--database", "saasmail", "--yes"],
      {
        wrangler: real.wrangler,
        log: () => {},
      },
    );
    const fileCalls = real.calls.filter((args) => args.includes("--file"));
    expect(fileCalls).toHaveLength(loaded.paths.length);
    expect(fileCalls[0]).toEqual([
      "d1",
      "execute",
      "saasmail",
      "--remote",
      "--file",
      loaded.paths[0],
      "--yes",
    ]);

    const declined = await main(["--from", dir, "--database", "saasmail"], {
      wrangler: stubWrangler().wrangler,
      log: () => {},
      confirm: async () => false,
    });
    expect(declined.cancelled).toBe(true);
  });

  it("checks its options", () => {
    expect(() => parseArgs(["--database", "x"])).toThrow("--from");
    expect(() =>
      parseArgs(["--from", "s3://bucket/x", "--database", "x"]),
    ).toThrow("rclone");
    expect(() =>
      parseArgs(["--from", "d", "--database", "x", "--key", "12"]),
    ).toThrow("64 hex");
    expect(
      parseArgs([
        "--from",
        "d",
        "--database",
        "x",
        "--local",
        "--tables",
        "a, b",
      ]),
    ).toMatchObject({
      local: true,
      tables: ["a", "b"],
    });
  });
});
