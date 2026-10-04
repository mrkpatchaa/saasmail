#!/usr/bin/env node
// Loads a saasmail database backup into a D1 database.
//
//   node scripts/restore-backup.mjs --from <dir> --database <d1 name>
//     [--key <64 hex>] [--tables a,b] [--local [--persist-to <dir>]]
//     [--dry-run] [--yes]
//
// <dir> is a backup prefix copied out of the bucket (`rclone copy`, or
// `wrangler r2 object get` per file): manifest.json, manifest.sha256 and one
// <table>.ndjson.gz[.enc] per table. The target must already have run
// `yarn db:migrate:prod` (at least the backup's last migration). A full
// restore empties every table in the backup and loads it; tables a backup
// leaves out (sessions, tokens, rate limits) are not touched. With
// --tables, those tables' rows are written over the current ones by primary
// key and nothing is deleted: emptying one table would cascade into others
// (D1 cannot turn foreign keys off). R2 objects (attachments, raw
// messages) are not part of a backup: copy the bucket to move them.
// See docs/data.md#backups.

import { createDecipheriv, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

/** D1 refuses statements longer than 100 KB; stay well under. */
const MAX_STATEMENT = 90_000;
/** A value longer than this goes in with appends after its row. */
const MAX_VALUE = 30_000;
/** One `--file` a few megabytes at most. */
const MAX_FILE = 4 * 1024 * 1024;

export function parseArgs(argv) {
  const options = {
    from: null,
    database: null,
    key: null,
    tables: null,
    local: false,
    persistTo: null,
    dryRun: false,
    yes: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--from") options.from = value();
    else if (arg === "--database") options.database = value();
    else if (arg === "--key") options.key = value();
    else if (arg === "--tables") {
      options.tables = value()
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
    } else if (arg === "--local") options.local = true;
    else if (arg === "--persist-to") options.persistTo = value();
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--yes") options.yes = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.from) throw new Error("--from <dir> is required");
  if (options.from.startsWith("s3://") || options.from.startsWith("r2://")) {
    throw new Error(
      "Copy the backup out of the bucket first (rclone copy, or wrangler r2 object get) and pass the local directory",
    );
  }
  if (!options.database) throw new Error("--database <d1 name> is required");
  if (options.persistTo && !options.local) {
    throw new Error("--persist-to needs --local");
  }
  if (options.key !== null && !/^[0-9a-fA-F]{64}$/.test(options.key)) {
    throw new Error("--key must be 64 hex characters");
  }
  return options;
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The manifest, checked against manifest.sha256. */
export function readManifest(dir) {
  const bytes = readFileSync(join(dir, "manifest.json"));
  const sumFile = join(dir, "manifest.sha256");
  if (existsSync(sumFile)) {
    const expected = readFileSync(sumFile, "utf8").split(/\s+/)[0];
    if (sha256(bytes) !== expected) {
      throw new Error("manifest.json does not match manifest.sha256");
    }
  }
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.format !== 1 || manifest.app !== "saasmail") {
    throw new Error("Not a saasmail backup manifest (format 1)");
  }
  return manifest;
}

/** Checks every part of every file against the manifest's hashes. */
export function verifyFiles(dir, manifest, tables = manifest.tables) {
  for (const table of tables) {
    const path = join(dir, table.file);
    if (!existsSync(path)) throw new Error(`${table.file} is missing`);
    const bytes = readFileSync(path);
    let at = 0;
    for (const [index, part] of table.parts.entries()) {
      const slice = bytes.subarray(at, at + part.bytes);
      if (slice.length !== part.bytes || sha256(slice) !== part.sha256) {
        throw new Error(
          `${table.file}: part ${index + 1} does not match its hash`,
        );
      }
      at += part.bytes;
    }
    if (at !== bytes.length) {
      throw new Error(`${table.file} is ${bytes.length} bytes, not ${at}`);
    }
  }
}

/** The plaintext of an encrypted file: length-prefixed AES-256-GCM frames. */
export function decryptFrames(bytes, keyHex) {
  const key = Buffer.from(keyHex, "hex");
  const chunks = [];
  let at = 0;
  while (at < bytes.length) {
    const length = bytes.readUInt32BE(at);
    const iv = bytes.subarray(at + 4, at + 16);
    const sealed = bytes.subarray(at + 16, at + 4 + length);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    chunks.push(
      decipher.update(sealed.subarray(0, sealed.length - 16)),
      decipher.final(),
    );
    at += 4 + length;
  }
  return Buffer.concat(chunks);
}

/** A table's rows. Blobs come back as Buffers. */
export function readRows(dir, table, manifest, keyHex) {
  let bytes = readFileSync(join(dir, table.file));
  if (manifest.encryption) {
    if (!keyHex) {
      throw new Error("This backup is encrypted: pass --key with its key");
    }
    bytes = decryptFrames(bytes, keyHex);
  }
  // gunzip reads every member of a multi-member file.
  return gunzipSync(bytes)
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line);
      for (const [column, value] of Object.entries(row)) {
        if (value && typeof value === "object" && "$blob" in value) {
          row[column] = Buffer.from(value.$blob, "base64");
        }
      }
      return row;
    });
}

const identifier = (name) => `"${name.replace(/"/g, '""')}"`;

/** A value as an SQLite literal. */
export function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (Buffer.isBuffer(value)) return `X'${value.toString("hex")}'`;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * A long value in pieces of about `size` (a string never split inside a
 * surrogate pair, so an emoji is not cut in two).
 */
export function pieces(value, size) {
  const out = [];
  if (Buffer.isBuffer(value)) {
    for (let at = 0; at < value.length; at += size) {
      out.push(value.subarray(at, at + size));
    }
    return out;
  }
  let at = 0;
  while (at < value.length) {
    let end = Math.min(at + size, value.length);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) end--;
    out.push(value.slice(at, end));
    at = end;
  }
  return out;
}

/** The migration's number: `0083_backup_runs` → 83. */
const migrationNumber = (name) => Number(/^(\d+)/.exec(name ?? "")?.[1] ?? -1);

/**
 * The SQL that loads `data` (table name → rows) into a target with
 * `targetColumns` (table name → its columns): every table emptied, children
 * first, then filled, parents first. `partial` (some tables only): nothing
 * is emptied, and each row is written over the one with its primary key.
 * Returns the files' contents in order and warnings.
 */
export function planSql(manifest, data, targetColumns, partial = false) {
  const warnings = [];
  const tables = manifest.tables.filter((table) => data.has(table.name));
  const missing = tables.filter((table) => !targetColumns.has(table.name));
  for (const table of missing) {
    warnings.push(`${table.name}: not in the target, skipped`);
  }
  const loading = tables.filter((table) => targetColumns.has(table.name));
  const files = [];
  let current = "";
  const header = "PRAGMA defer_foreign_keys = ON;\n";
  const push = (statement) => {
    if (current && current.length + statement.length > MAX_FILE) {
      files.push(header + current);
      current = "";
    }
    current += `${statement}\n`;
  };

  if (!partial) {
    for (const table of [...loading].reverse()) {
      push(`DELETE FROM ${identifier(table.name)};`);
    }
    files.push(header + current);
    current = "";
  }

  for (const table of loading) {
    const target = targetColumns.get(table.name);
    const rows = data.get(table.name);
    const backedUp = rows[0] ? Object.keys(rows[0]) : table.columns;
    const columns = backedUp.filter((column) => target.has(column));
    for (const column of backedUp.filter((column) => !target.has(column))) {
      warnings.push(`${table.name}.${column}: not in the target, skipped`);
    }
    if (columns.length === 0) continue;
    const head = `INSERT INTO ${identifier(table.name)} (${columns.map(identifier).join(", ")}) VALUES `;
    const keyed =
      table.primaryKey.length > 0 &&
      table.primaryKey.every((column) => columns.includes(column));
    const updates = columns.filter(
      (column) => !table.primaryKey.includes(column),
    );
    const tail =
      partial && keyed
        ? ` ON CONFLICT (${table.primaryKey.map(identifier).join(", ")}) DO ${
            updates.length > 0
              ? `UPDATE SET ${updates.map((column) => `${identifier(column)} = excluded.${identifier(column)}`).join(", ")}`
              : "NOTHING"
          }`
        : "";
    let values = [];
    let size = head.length + tail.length;
    const flush = () => {
      if (values.length === 0) return;
      push(`${head}${values.join(", ")}${tail};`);
      values = [];
      size = head.length + tail.length;
    };
    for (const row of rows) {
      const appends = [];
      const cells = columns.map((column) => {
        const value = row[column];
        const text = literal(value);
        if (text.length <= MAX_VALUE) return text;
        // Too long for one statement: start empty, append in pieces.
        appends.push(column);
        return Buffer.isBuffer(value) ? "X''" : "''";
      });
      const tuple = `(${cells.join(", ")})`;
      if (size + tuple.length + 2 > MAX_STATEMENT) flush();
      values.push(tuple);
      size += tuple.length + 2;
      if (appends.length > 0) {
        flush();
        const key = table.primaryKey.length > 0 ? table.primaryKey : null;
        if (!key) {
          warnings.push(
            `${table.name}: a long value in a row without a key was cut`,
          );
          continue;
        }
        const where = key
          .map((column) => `${identifier(column)} = ${literal(row[column])}`)
          .join(" AND ");
        for (const column of appends) {
          for (const piece of pieces(row[column], MAX_VALUE / 2)) {
            push(
              `UPDATE ${identifier(table.name)} SET ${identifier(column)} = ${identifier(column)} || ${literal(piece)} WHERE ${where};`,
            );
          }
        }
      }
    }
    flush();
  }
  if (current) files.push(header + current);
  return { files, warnings, tables: loading };
}

/** Runs wrangler and returns its stdout. */
function runWrangler(args) {
  return execFileSync(process.env.WRANGLER ?? "wrangler", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/** Where wrangler runs: the account's database, or a local one. */
function targetArgs(options) {
  if (!options.local) return ["--remote"];
  return options.persistTo
    ? ["--local", "--persist-to", options.persistTo]
    : ["--local"];
}

/** The JSON results of `wrangler d1 execute --json`. */
function d1Json(wrangler, options, command) {
  const out = wrangler([
    "d1",
    "execute",
    options.database,
    ...targetArgs(options),
    "--json",
    "--command",
    command,
  ]);
  return JSON.parse(out);
}

/** The target's last applied migration and its tables' columns. */
export function inspectTarget(wrangler, options, tableNames) {
  const [migrations] = d1Json(
    wrangler,
    options,
    "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1",
  );
  const lastMigration = migrations?.results?.[0]?.name ?? null;
  const pragmas = tableNames
    .map((name) => `PRAGMA table_info(${identifier(name)});`)
    .join(" ");
  const results = d1Json(wrangler, options, pragmas);
  const columns = new Map();
  tableNames.forEach((name, index) => {
    const rows = results[index]?.results ?? [];
    if (rows.length > 0)
      columns.set(name, new Set(rows.map((row) => row.name)));
  });
  return { lastMigration, columns };
}

export async function main(argv, deps = {}) {
  const wrangler = deps.wrangler ?? runWrangler;
  const log = deps.log ?? ((line) => console.log(line));
  const confirm =
    deps.confirm ??
    (async (question) => {
      if (!process.stdin.isTTY) return false;
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      const answer = await rl.question(question);
      rl.close();
      return answer.trim() === "yes";
    });

  const options = parseArgs(argv);
  const manifest = readManifest(options.from);
  const chosen = options.tables
    ? manifest.tables.filter((table) => options.tables.includes(table.name))
    : manifest.tables;
  if (options.tables) {
    for (const name of options.tables) {
      if (!manifest.tables.some((table) => table.name === name)) {
        throw new Error(`${name} is not in this backup`);
      }
    }
  }
  verifyFiles(options.from, manifest, chosen);
  if (manifest.encryption && !options.key) {
    throw new Error("This backup is encrypted: pass --key with its key");
  }

  const target = inspectTarget(
    wrangler,
    options,
    chosen.map((table) => table.name),
  );
  if (
    manifest.lastMigration &&
    migrationNumber(target.lastMigration) <
      migrationNumber(manifest.lastMigration)
  ) {
    throw new Error(
      `The target's last migration is ${target.lastMigration ?? "none"}, older than the backup's ${manifest.lastMigration}: run yarn db:migrate:prod against it first`,
    );
  }

  const data = new Map(
    chosen.map((table) => [
      table.name,
      readRows(options.from, table, manifest, options.key),
    ]),
  );
  const plan = planSql(manifest, data, target.columns, options.tables !== null);
  const rows = plan.tables.reduce(
    (n, table) => n + data.get(table.name).length,
    0,
  );
  log(
    `Backup of ${new Date(manifest.startedAt * 1000).toISOString()} (migration ${manifest.lastMigration ?? "unknown"}) into ${options.database} (${options.local ? "local" : "remote"}, migration ${target.lastMigration ?? "none"}):`,
  );
  for (const table of plan.tables) {
    log(`  ${table.name}: ${data.get(table.name).length} rows`);
  }
  log(
    `${plan.tables.length} tables, ${rows} rows, ${plan.files.length} SQL files.`,
  );
  for (const warning of plan.warnings) log(`warning: ${warning}`);

  const dir = mkdtempSync(join(tmpdir(), "saasmail-restore-"));
  const paths = plan.files.map((sql, index) => {
    const path = join(dir, `${String(index).padStart(4, "0")}.sql`);
    writeFileSync(path, sql);
    return path;
  });
  if (options.dryRun) {
    log(`Dry run: nothing loaded. The SQL is in ${dir}.`);
    return { dryRun: true, paths, plan };
  }
  const go =
    options.yes ||
    (await confirm(
      options.tables
        ? `This writes the backup's rows of ${plan.tables.length} tables over those in ${options.database}. Type yes to go on: `
        : `This empties and reloads ${plan.tables.length} tables in ${options.database}. Type yes to go on: `,
    ));
  if (!go) {
    log("Nothing loaded.");
    return { dryRun: false, cancelled: true, paths, plan };
  }
  for (const [index, path] of paths.entries()) {
    log(`Loading ${index + 1}/${paths.length}…`);
    wrangler([
      "d1",
      "execute",
      options.database,
      ...targetArgs(options),
      "--file",
      path,
      "--yes",
    ]);
  }
  log(
    `Done. R2 objects (${(manifest.r2Prefixes ?? []).join(", ")}) are not part of a backup: copy the bucket if you moved accounts.`,
  );
  return { dryRun: false, paths, plan };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
