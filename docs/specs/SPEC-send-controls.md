# SPEC: Sending controls — pause switch, agent kill switch, daily caps

Stage 9 (trust and safety), slice 4 of 5. Depends on `docs/archive/SPEC-audit-log.md` (events) and
`docs/archive/SPEC-send-idempotency.md` (shared boundary code in the send routes). Label `minor`.

## Why

When something goes wrong — a misconfigured rule auto-replying in a loop, an agent client with a bad
prompt, a leaked API key, a campaign sent to the wrong list — there is no way to stop outbound mail
short of redeploying or deleting the sender's API key. Mailroom has `MCP_SEND_ENABLED=false` (every
agent loses its send tools at once) and a daily cap per identity. Mailflare has none of this; we should
have both, and a pause that loses nothing.

## Decisions (proposed 2026-10-03)

1. **Pause holds, never drops.** Admins toggle "Pause outbound sending" in Settings. While paused,
   every send path still writes its `sent_emails` and `outbox_emails` rows, but no attempt is made:
   `sendViaOutbox` skips the inline attempt and `processOutbox` returns early. Resuming lets the
   hourly processor (and an immediate run triggered by the resume) deliver what accumulated. Nothing
   is refused, nothing is lost, the audit log says who paused and when.
2. **`MCP_SEND_ENABLED` env var** (default on; `"false"` disables): the MCP tools that cause mail —
   `send_email`, `reply_email`, `send_template`, `enroll_sequence` — refuse with a clear error. They stay
   listed (the inventory test is unchanged, and clients see the explanation instead of a missing tool).
   This is the deploy-time kill switch for every connected agent at once; the pause is the runtime one
   for everything.
3. **Daily caps per user per channel, counted at acceptance** (one per accepted message, before the
   outbox). Settings: `daily_send_limit_mcp` (default 200), `daily_send_limit_api` (API-key callers,
   default unlimited), `daily_send_limit_web` (default unlimited), `daily_send_limit_jmap` (default
   unlimited). `null` = unlimited, `0` = blocked. Campaigns and sequences are not counted: they have
   `PROVIDER_DAILY_SEND_LIMIT` and their own ledgers. Over the cap: HTTP `429 DAILY_SEND_LIMIT_REACHED`
   with `Retry-After` = seconds to the next UTC midnight; MCP tool error with the same text; JMAP
   `EmailSubmission/set` `notCreated` with `forbiddenToSend` and a description.
4. The day is the UTC date. Counters live in D1 and are incremented atomically; the check is
   increment-then-compare, so two concurrent sends cannot both squeeze under the cap.

## 1. Pause

**Files:** `worker/src/lib/outbox.ts` (`sendViaOutbox`, `processOutbox`), `worker/src/lib/sending-controls.ts`
(new: `isSendingPaused(db)`, `setSendingPaused(db, actor, paused)`, cached per request), `worker/src/routers/admin-router.ts`
(`/settings`), `worker/src/routers/outbox-router.ts` (`/count` gains `held`), `src/pages/SettingsPage.tsx`,
`src/components/DashboardLayout.tsx` (banner), `src/pages/ComposeModal.tsx`.

- `app_settings` key `outbound_paused`: JSON `{ "since": <unix>, "byUserId": "…", "byLabel": "…" }`, or
  absent. Written only through the admin settings route (admin, passkey-gated).
- `sendViaOutbox`: after inserting the row, if paused → set `next_retry_at = now` (so it is "due" the
  moment sending resumes), return `{ outcome: "retrying", send: <no provider call>, outboxId }` and
  the send-path callers record the sent row with their existing `retrying` handling. No provider is
  called. `processOutbox`: `if (await isSendingPaused(db)) return;` before claiming rows. The JMAP
  delayed-send release goes through `sendViaOutbox` and is therefore held too; the submission stays
  `pending`.
- Resume: the route clears the key, emits `sending.resumed`, and `ctx.waitUntil(processOutbox(env))`
  so held mail goes out within seconds, not at the next hour.
- API/MCP responses while paused keep their shape; `status` is `"retrying"` and a new boolean
  `paused: true` is added to the send response schemas so a client can tell the difference.
- UI: a banner on every page for admins ("Outbound sending is paused since 14:02 by Jane. Resume") and
  a one-line notice above the Send button in composers for everyone ("Sending is paused; your message
  will be queued"). Settings → Sending: the toggle, who/when, and the held count from
  `GET /api/outbox/count`.

## 2. MCP kill switch

**Files:** `worker/src/mcp/server.ts`, `worker-configuration.d.ts` / `wrangler.jsonc.example`,
`docs/configuration.md`, `docs/mcp.md`.

- `env.MCP_SEND_ENABLED === "false"` → the four tools' handlers return the MCP error
  `MCP_SEND_DISABLED: "Sending through MCP is disabled on this server by its administrator."` before
  any work (checked inside the scope wrapper so the scope error still wins for unscoped tokens).
- The tool descriptions do not change; `whoami` gains `sendEnabled: boolean` so a client can know up
  front.

## 3. Daily caps

**Files:** `worker/src/db/send-counters.schema.ts` (+ `schema.ts`, migration, `helpers.ts`),
`worker/src/lib/sending-controls.ts` (`reserveDailySend(db, { userId, channel, limit })`),
`worker/src/routers/send-router.ts`, `worker/src/routers/email-templates-router.ts`, `worker/src/mcp/server.ts`,
`worker/src/jmap/submission.ts`, `worker/src/routers/admin-router.ts`, `src/pages/SettingsPage.tsx`.

```
send_counters (user_id TEXT NOT NULL, channel TEXT NOT NULL, day TEXT NOT NULL /* YYYY-MM-DD UTC */,
               count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, channel, day))
```

- `reserveDailySend`: reads the channel's limit from `app_settings` (`null` → return `allowed`
  without touching the table); `INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`;
  if `count > limit` → `UPDATE … SET count = count - 1` and return `{ allowed: false, retryAfter }`.
  Called once per accepted message in each boundary, after validation and the idempotency claim
  (a replay never counts) and before `sendEmail`/`replyToEmail`/`submitMessage`. Channel comes from the
  audit actor (`web`, `api`, `mcp`, `jmap`).
- Over the cap also emits `send.limit_reached` once per user/channel/day (the first refusal), so the
  log isn't flooded.
- Rows older than 7 days are pruned in the hourly chain.
- Settings → Sending: four numeric fields (blank = unlimited) with the per-channel count today for the
  signed-in admin's team (`GET /api/admin/send-usage?day=` → counts grouped by channel and user, top 20).

## 4. Settings route

`PATCH /api/admin/settings` (the existing route) accepts `outboundPaused: boolean`,
`dailySendLimits: { mcp, api, web, jmap: number | null }`; each change emits `settings.changed`
(and `sending.paused`/`sending.resumed` for the toggle). `GET /api/config` (`bootstrap-router.ts`, which already
serves `brandName` and `webmcpEnabled`) exposes `outboundPaused` and `dailySendLimits` so the banner and
composers can render without an admin call.

## Tests

- Pause: `sendViaOutbox` writes the row and calls no provider when paused; `processOutbox` is a no-op;
  resume processes the held row; the JMAP delayed release is held.
- Kill switch: each of the four tools refuses with `MCP_SEND_DISABLED` when the var is `"false"`;
  `whoami.sendEnabled`; inventory unchanged.
- Caps: the 201st MCP send of a UTC day is refused with the right `Retry-After`; two concurrent sends at
  the boundary admit exactly one; `null` never touches the table; a replayed idempotent send doesn't
  count; JMAP returns `forbiddenToSend`; prune.
- Web (vitest): banner and composer notice; settings form round-trips.

## Docs and CHANGELOG

- `docs/configuration.md`: `MCP_SEND_ENABLED`. New section "Sending controls" in `docs/users-and-api-keys.md`
  or a new `docs/sending.md` (pause, caps, what counts). `docs/mcp.md`: the kill switch and the cap
  error. `docs/jmap.md`: `forbiddenToSend` when over the cap.
- CHANGELOG `### Added`: **Pause outbound sending, agent kill switch and daily send caps.** …

## Spec changes (implementation)

The four decisions are unchanged. What the code does differently, and why:

1. **The pause sits at the provider call, not only in `sendViaOutbox`.** `sendWithSuppressionCheck`, which
   every send path goes through, swaps in a sender that answers a temporary failure marked `paused`
   (`pausedSender`). The outbox holds that like any temporary failure. Two sends have no outbox row and
   are not sent while paused: the campaign test send answers `sent: false` (it answered `true` for any
   recipient that was not suppressed, even when the provider refused), and a list subscription
   confirmation is not recorded as sent (it was, even when the provider refused); the membership stays
   pending and the subscriber can submit the form again. A held row records no attempt
   (`attempts = 0`), and a one-shot send (a rule auto-reply) is held instead of dropped.
2. **A held row keeps the outbox's one-minute cool-down** (`next_retry_at = now + 60`, not `now`): the
   cool-down protects the caller's own write of the Sent row. A message accepted in the last minute
   before a resume therefore goes at the next hourly run.
3. **A retry while paused gives its attempt back** (`attemptOutboxRow`), so pressing Retry, or a run
   that started before the pause, can never use up a held message's 24 attempts and fail it.
4. **The delayed JMAP release does not start while paused** (`releaseScheduledSubmission` answers
   `notDue` before its claim) instead of being held in the outbox: the submission stays `scheduled`,
   and can still be canceled. The resume runs `processOutbox` and then `releaseOverdueSubmissions`, as
   the system (`cron` channel) rather than as the admin who resumed.
5. **Inbox forwarding is skipped while paused** (logged): a forward is built from the raw inbound
   message and has no outbox row to wait in. The message itself is in the inbox.
6. `setSendingPaused(db, paused)` takes the actor from the audit context, like every other audit
   writer. The pause is read once per database handle (one request, queue batch or cron pass).
7. **The toggle records only `sending.paused` / `sending.resumed`**, not also `settings.changed`; a
   limit change records `settings.changed` per channel changed.
8. **`GET /api/config` exposes `outboundPaused` only.** The route needs no sign-in, and nothing in the
   app needs the limits before an admin opens Settings. Who paused and when, and the limits, are in a
   new `GET /api/admin/settings` (there was no GET); `PATCH` answers the same shape.
9. `GET /api/outbox/count` gains `paused` as well as `held` (`held` is the pending count while paused,
   0 otherwise), so Settings → Sending needs one call.
10. **`reserveDailySend(db, { userId, channel })` reads the limit itself.** The HTTP check lives once in
    `respondIdempotently`, shared by the three send routes (inside the idempotency claim, so a replay
    never counts and a 429 frees the key); MCP counts in `sendOnce` with channel `mcp`; JMAP counts in
    `createSubmission` after every validation and before scheduling (a delayed send counts when it is
    submitted). `enroll_sequence` is not counted (sequences are not). A send refused after the
    reservation (no access, a missing template, a 4xx, a thrown error) gives its slot back; one that
    failed after the provider accepted it gives it back too, so the count can run one short then.
11. The MCP error is `DAILY_SEND_LIMIT_REACHED: <the HTTP error text>`, like `MCP_SEND_DISABLED: …`.
    `0` reads "Sending through <channel> is turned off on this server by its administrator."
12. `send.limit_reached` is deduplicated by its target id `<userId>:<channel>:<day>`.
13. Limits are whole numbers from 0 to 1,000,000; `null` (stored as `"null"`) is an explicit
    unlimited, an absent row the default.
14. Settings → Sending lists the top 20 counts of the day for everyone, not "the signed-in admin's
    team" (there are no teams).
