// docs/doctor.md: `yarn doctor`, against stubbed wrangler, git and HTTP.
import { describe, expect, it } from "vitest";
import {
  exitCode,
  main,
  mergeReports,
  parseArgs,
  parseWranglerConfig,
  pendingMigrations,
  uncoveredDirtyFiles,
} from "./doctor.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";

const CONFIG = `{
  // The deployment's config.
  "name": "saasmail",
  "d1_databases": [{ "binding": "DB", "database_name": "saasmail-db" }],
  "ai": { "binding": "AI" },
  "r2_buckets": [{ "binding": "R2", "bucket_name": "att" },],
  "queues": { "producers": [{ "binding": "EMAIL_QUEUE", "queue": "q" }] },
  "durable_objects": {
    "bindings": [
      { "name": "NOTIFICATIONS_HUB", "class_name": "NotificationsHub" },
      { "name": "MAIL_AGENT", "class_name": "MailAgent" },
    ],
  },
  "vars": { "UNSUBSCRIBE_SECRET": "x" },
}`;

function runtimeReport(overrides = {}) {
  return {
    build: {
      version: "0.10.0",
      commit: SHA,
      commitShort: SHA.slice(0, 7),
      commitTime: "2026-10-29T00:00:00Z",
      dirty: false,
      dirtyFiles: [],
      dirtyCount: 0,
      builtAt: "2026-10-29T00:00:00.000Z",
      ...overrides.build,
    },
    checkedAt: 1,
    checks: overrides.checks ?? [
      {
        id: "provider.outbound",
        group: "provider",
        status: "pass",
        summary: "Outbound provider: Resend (ResendSender).",
      },
    ],
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** A world where everything passes, with per-test overrides. */
function deps(overrides = {}) {
  const calls = [];
  const out = [];
  return {
    calls,
    out,
    deps: {
      readFile: () => CONFIG,
      env: { SAASMAIL_ADMIN_KEY: "sk_admin", ...overrides.env },
      git: async () => SHA,
      print: (text) => out.push(text),
      exec: async (command, args) => {
        calls.push([command, ...args].join(" "));
        if (overrides.exec) {
          const r = await overrides.exec(args);
          if (r) return r;
        }
        if (args.includes("migrations")) {
          return {
            code: 0,
            timedOut: false,
            stdout: "✅ No migrations to apply!",
            stderr: "",
          };
        }
        return {
          code: 0,
          timedOut: false,
          stdout: JSON.stringify([
            { name: "BETTER_AUTH_SECRET", type: "secret_text" },
            { name: "TOKEN_ENCRYPTION_KEY", type: "secret_text" },
          ]),
          stderr: "",
        };
      },
      fetch: async (url, init) => {
        calls.push(String(url));
        if (overrides.fetch) {
          const r = await overrides.fetch(String(url), init);
          if (r) return r;
        }
        if (String(url).endsWith("/api/admin/doctor"))
          return json(runtimeReport());
        if (String(url).endsWith("/api/admin/inboxes"))
          return json([{ email: "help@example.com", source: "cloudflare" }]);
        throw new Error(`unexpected fetch ${url}`);
      },
    },
  };
}

const ARGS = [
  "--config",
  "wrangler.jsonc",
  "--url",
  "https://mail.example.com/",
];

describe("parseArgs", () => {
  it("reads the options and normalises the URL", () => {
    const o = parseArgs([...ARGS, "--strict", "--allow-dirty", "a", "b/"]);
    expect(o).toMatchObject({
      config: "wrangler.jsonc",
      url: "https://mail.example.com",
      strict: true,
      allowDirty: ["a", "b/"],
    });
  });
  it("refuses a missing option or a bad URL", () => {
    expect(() => parseArgs(["--config", "x"])).toThrow(/Usage/);
    expect(() => parseArgs(["--config", "x", "--url", "nope"])).toThrow();
  });
});

describe("parseWranglerConfig", () => {
  it("parses JSONC with comments and trailing commas", () => {
    const c = parseWranglerConfig(CONFIG);
    expect(c.name).toBe("saasmail");
    expect(c.database).toBe("saasmail-db");
    expect([...c.bindings].sort()).toEqual(
      [
        "AI",
        "DB",
        "EMAIL_QUEUE",
        "MAIL_AGENT",
        "NOTIFICATIONS_HUB",
        "R2",
      ].sort(),
    );
    expect(c.vars.has("UNSUBSCRIBE_SECRET")).toBe(true);
  });
  it("throws on a syntax error", () => {
    expect(() => parseWranglerConfig('{ "name": }')).toThrow(/invalid JSONC/);
  });
});

describe("helpers", () => {
  it("reads pending migration names", () => {
    expect(pendingMigrations("✅ No migrations to apply!")).toEqual([]);
    expect(
      pendingMigrations("│ 0091_remove-subscribe-forms.sql │\n│ 0092_x.sql │"),
    ).toEqual(["0091_remove-subscribe-forms.sql", "0092_x.sql"]);
  });
  it("merges script lines and runtime checks", () => {
    const merged = mergeReports([{ status: "pass", label: "Config" }], {
      checks: [{ status: "warn", summary: "Backups off", hint: "Turn on" }],
    });
    expect(merged).toEqual([
      { status: "pass", label: "Config" },
      { status: "warn", label: "Backups off", hint: "Turn on", runtime: true },
    ]);
  });
  it("exits 1 on a failure, and on a warning only with --strict", () => {
    const warn = [{ status: "pass" }, { status: "warn" }];
    expect(exitCode(warn, false)).toBe(0);
    expect(exitCode(warn, true)).toBe(1);
    expect(exitCode([{ status: "fail" }], false)).toBe(1);
    expect(exitCode([{ status: "info" }], true)).toBe(0);
  });
  it("covers dirty files by path or directory", () => {
    const build = {
      dirty: true,
      dirtyFiles: ["public/logo.svg", "src/x.ts"],
      dirtyCount: 2,
    };
    expect(uncoveredDirtyFiles(build, ["public/"])).toEqual(["src/x.ts"]);
    expect(uncoveredDirtyFiles(build, ["public", "src/x.ts"])).toEqual([]);
    expect(
      uncoveredDirtyFiles({ ...build, dirtyCount: 12 }, ["public", "src"]),
    ).toEqual(["10 more not named in the stamp"]);
  });
});

describe("main", () => {
  it("passes a healthy deployment", async () => {
    const world = deps();
    const { code, lines } = await main(ARGS, world.deps);
    expect(lines.filter((l) => l.status === "fail")).toEqual([]);
    expect(code).toBe(0);
    expect(world.out.join("\n")).toContain("Cloudflare API: skipped");
  });

  it("never prints the admin key or the token", async () => {
    const world = deps({ env: { CLOUDFLARE_API_TOKEN: "cf_secret_token" } });
    world.deps.fetch = async (url) => {
      if (url.endsWith("/api/admin/doctor")) return json(runtimeReport());
      if (url.endsWith("/api/admin/inboxes")) return json([]);
      throw new Error("unreachable");
    };
    await main(ARGS, world.deps);
    const out = world.out.join("\n");
    expect(out).not.toContain("sk_admin");
    expect(out).not.toContain("cf_secret_token");
  });

  it("exits 1 when the migrations list fails", async () => {
    const world = deps({
      exec: async (args) =>
        args.includes("migrations")
          ? { code: 1, timedOut: false, stdout: "", stderr: "Not logged in" }
          : null,
    });
    const { code, lines } = await main(ARGS, world.deps);
    expect(code).toBe(1);
    expect(lines.find((l) => l.status === "fail").label).toContain(
      "Not logged in",
    );
  });

  it("exits 1 on a pending migration", async () => {
    const world = deps({
      exec: async (args) =>
        args.includes("migrations")
          ? {
              code: 0,
              timedOut: false,
              stdout: "│ 0092_new.sql │",
              stderr: "",
            }
          : null,
    });
    expect((await main(ARGS, world.deps)).code).toBe(1);
  });

  it("exits 1 when the endpoint answers 401", async () => {
    const world = deps({
      fetch: async (url) =>
        url.endsWith("/api/admin/doctor")
          ? json({ error: "Unauthorized" }, 401)
          : null,
    });
    const { code, lines } = await main(ARGS, world.deps);
    expect(code).toBe(1);
    expect(lines.some((l) => l.label.includes("HTTP 401"))).toBe(true);
  });

  it("exits 1 on a malformed body", async () => {
    const world = deps({
      fetch: async (url) =>
        url.endsWith("/api/admin/doctor") ? json({ ok: true }) : null,
    });
    const { code, lines } = await main(ARGS, world.deps);
    expect(code).toBe(1);
    expect(lines.some((l) => l.label.includes("no build and checks"))).toBe(
      true,
    );
  });

  it("exits 1 on a timeout", async () => {
    const world = deps({
      fetch: async (url) => {
        if (!url.endsWith("/api/admin/doctor")) return null;
        const e = new Error("The operation was aborted due to timeout");
        e.name = "TimeoutError";
        throw e;
      },
    });
    const { code, lines } = await main(ARGS, world.deps);
    expect(code).toBe(1);
    expect(lines.some((l) => l.label.includes("timed out"))).toBe(true);
  });

  it("exits 1 when a runtime check fails", async () => {
    const world = deps({
      fetch: async (url) =>
        url.endsWith("/api/admin/doctor")
          ? json(
              runtimeReport({
                checks: [
                  {
                    id: "migrations.pending",
                    group: "migrations",
                    status: "fail",
                    summary: "1 migration not applied",
                  },
                ],
              }),
            )
          : null,
    });
    expect((await main(ARGS, world.deps)).code).toBe(1);
  });

  it("--allow-dirty clears a matching dirty stamp", async () => {
    const dirty = runtimeReport({
      build: { dirty: true, dirtyFiles: ["public/logo.svg"], dirtyCount: 1 },
    });
    const fetchDirty = async (url) =>
      url.endsWith("/api/admin/doctor") ? json(dirty) : null;

    const plain = await main(
      [...ARGS, "--strict"],
      deps({ fetch: fetchDirty }).deps,
    );
    expect(plain.code).toBe(1);
    expect(plain.lines.some((l) => l.label.includes("public/logo.svg"))).toBe(
      true,
    );

    const allowed = await main(
      [...ARGS, "--strict", "--allow-dirty", "public/logo.svg"],
      deps({ fetch: fetchDirty }).deps,
    );
    expect(allowed.code).toBe(0);
  });

  it("checks Email Routing, and skips the Sending check for a non-Cloudflare provider", async () => {
    const world = deps({
      env: { CLOUDFLARE_API_TOKEN: "cf" },
      fetch: async (url) => {
        if (url.includes("/zones?")) {
          return json({
            success: true,
            result: url.includes("name=example.com")
              ? [{ id: "z1", name: "example.com" }]
              : [],
          });
        }
        if (url.includes("/email/routing/rules/catch_all")) {
          return json({ success: true, result: { enabled: false } });
        }
        if (url.includes("/email/routing/rules")) {
          return json({
            success: true,
            result: [
              {
                enabled: true,
                matchers: [
                  { type: "literal", field: "to", value: "help@example.com" },
                ],
                actions: [{ type: "worker", value: ["saasmail"] }],
              },
            ],
          });
        }
        return null;
      },
    });
    const { code, lines } = await main(ARGS, world.deps);
    expect(code).toBe(0);
    expect(
      lines.find((l) => l.label.startsWith("Email Routing: help@")).status,
    ).toBe("pass");
    expect(
      lines.find((l) => l.label.startsWith("Email Sending")).label,
    ).toContain("not applicable");
    expect(world.calls.some((c) => c.includes("/email/sending/"))).toBe(false);
  });
});
