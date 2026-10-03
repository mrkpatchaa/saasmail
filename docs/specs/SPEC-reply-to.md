# SPEC: Replies go to the sender's Reply-To

Stage 9 (trust and safety), slice 1 of 5. Depends on nothing. Label `minor`.

## Why

`replyToEmail` (`worker/src/lib/send-email.ts`) addresses every reply to `people.email` of the
original's sender. The inbound `Reply-To` header is parsed into `raw_headers` and then ignored, so a
reply to a ticketing system, a `noreply@` notification that names a real support address, or any sender
who asked for answers elsewhere goes to the wrong mailbox. Every mail client and Mailroom honour
Reply-To; we are the exception.

Facts to build on: `emails` has no `reply_to` column; `raw_headers` is a JSON object of lowercase
header names → raw values (postal-mime), so older rows can be read without a migration;
`parseAddressHeader()` in `worker/src/lib/email-parser.ts` already turns such a value into
`ParsedEmailAddress[]`; postal-mime exposes `replyTo: Address[]`.

## Decisions (proposed 2026-10-03; change them in this file before implementing)

1. Replies default to the Reply-To address(es) when present. Callers may ask for the sender instead
   (`recipient: "sender"`). The web composer shows which one it will use and lets the user flip it.
2. Reply-To addresses that are our own inboxes (any `sender_identities.email`, case-insensitive) are
   dropped from the candidates; if none remain, the reply goes to the sender as today. This is the loop
   guard: a message whose Reply-To points back at us never produces a reply to ourselves.
3. Several Reply-To addresses: the first becomes To, the rest are added to Cc (deduplicated against the
   caller's Cc; `MAX_CC_ENTRIES` from `worker/src/lib/send-limits.ts` still applies).
4. The sent row keeps `person_id` = the original sender's person, so the reply stays on that customer's
   timeline. `to_address` is the Reply-To address. The timeline shows "to support@…" on the reply.
5. Rule auto-replies keep answering the sender (`recipient: "sender"`). An automatic response should not
   follow an attacker-controlled Reply-To; RFC 3834 points automatic responses at Return-Path/From.
6. No SQL backfill. Rows from before this change have `reply_to = NULL`; the reply path and the message
   reads fall back to `raw_headers["reply-to"]` through `parseAddressHeader()`, and the reply path writes
   the parsed value back so the fallback runs once per message.
7. JMAP keeps returning `replyTo: null` for now. It is an immutable Email property and this repo resets
   the account id when one changes (docs/jmap.md, id format v3). The reset is batched with
   `SPEC-header-threading.md`, which exposes `replyTo` then.

## 1. Parse and store

**Files:** `worker/src/lib/email-parser.ts`, `worker/src/db/emails.schema.ts`,
`worker/src/email-handler.ts`, `worker/src/__tests__/helpers.ts`, a generated migration.

- `ParsedEmail` gains `replyTo: ParsedEmailAddress[]` from postal-mime's `replyTo`: email trimmed and
  lowercased, name or `null`, entries without an `@` dropped, duplicates removed, at most 10 kept.
- `emails.reply_to TEXT NULL`: JSON `[{"email","name"}]`, exactly the `cc` convention; `NULL` when the
  header is absent or empty. `yarn db:generate`; update `applyMigrations()` in `helpers.ts`.
- `handleEmail` writes `replyTo: parsed.replyTo.length ? JSON.stringify(parsed.replyTo) : null`.
- A helper `replyToOf(row: { replyTo: string | null; rawHeaders: string | null }): MailAddress[]` in
  `worker/src/lib/messages/adapters.ts` returns the stored list, else the parsed fallback from
  `raw_headers`, else `[]`. Every reader below uses it; nothing parses `raw_headers` elsewhere.

## 2. Message reads

**Files:** `worker/src/lib/messages/types.ts`, `query.ts`, `adapters.ts`, `src/lib/api.ts`.

- `UnifiedMessage.replyTo: MailAddress[]` (received: `replyToOf(row)`; sent: `[]`). `query.ts` selects
  `reply_to` and `raw_headers` for the received arm only when the caller asks for `replyTo`
  (`withReplyTo: true`), so list queries don't carry `raw_headers` for every row; the reading pane,
  the conversation route, `read_email` (MCP) and the agent's read tools ask for it.
- `MailMessage` in `src/lib/api.ts` mirrors it.

## 3. Reply path

**Files:** `worker/src/lib/send-email.ts`, `worker/src/routers/send-router.ts`,
`worker/src/mcp/server.ts` (`reply_email`), `worker/src/lib/rules/auto-reply.ts`,
`src/lib/api.ts`, the reply composer (`src/components/mail/MailReadingPane.tsx` and the customer view's
reply paths in `src/pages/ConversationDetail.tsx`, `src/components/ThreadMessage.tsx` and
`src/components/ChatQuickReply.tsx`).

- `ReplyEmailParams` gains `recipient?: "reply_to" | "sender"` (default `"reply_to"`).
- For a received original: `candidates = replyToOf(orig)` minus our inbox addresses minus the From
  inbox of this reply. Non-empty and `recipient === "reply_to"` → `toAddress = candidates[0].email`,
  `candidates.slice(1)` appended to Cc (dedupe, cap). Otherwise `toAddress = people.email` as today.
  For a sent original nothing changes. If `orig.replyTo` was `NULL` and the fallback found addresses,
  write them to `emails.reply_to` (best effort, after the send).
- `ReplyEmailSuccess` gains `to: string` and `repliedTo: "reply_to" | "sender"`.
- `POST /api/send/reply/{emailId}`: optional `recipient` form field (zod enum); response gains `to`
  and `repliedTo`. Update the zod-openapi schemas so `/doc` is right.
- MCP `reply_email`: optional `recipient` input (`z.enum(["reply_to","sender"]).optional()`), the
  description says replies follow the message's Reply-To unless `recipient: "sender"`, and the result
  includes `to`. The tool inventory test is unchanged (no new tool).
- `runAutoReply` passes `recipient: "sender"`.
- Web: when a received message's `replyTo` (after the own-inbox filter) differs from its From, the reply
  composer shows "Replies go to support@acme.com (the sender asked for replies there)" with a
  "Reply to the sender instead" toggle; the toggle's value is sent as `recipient`. The reading pane's
  header block shows a `Reply-To:` line in the same case. `replyToEmail` in `src/lib/api.ts` takes
  `recipient`.

## Tests

- Parser: Reply-To with a display name; a list of three; an invalid entry dropped; absent → `[]`.
- Handler: `reply_to` stored as JSON; `NULL` when absent.
- `replyToEmail`: honours `reply_to`; three addresses → To + 2 Cc, deduped against caller Cc; a Reply-To
  equal to one of our inboxes falls back to the sender; `recipient: "sender"`; a sent original is
  unchanged; an old row with `reply_to NULL` and a `raw_headers` Reply-To uses it and writes it back;
  `sent_emails.person_id` is the original sender's person.
- Route and MCP: `recipient` validation, `to`/`repliedTo` in the response.
- Auto-reply still goes to the sender.
- Web (vitest): the hint renders only when Reply-To differs; the toggle flips the submitted `recipient`.

## Docs and CHANGELOG

- `docs/inboxes.md`: a "Replying" paragraph (Reply-To rule, own-inbox guard, the toggle, timeline
  attribution). `docs/mcp.md`: `reply_email` gains `recipient`. `docs/jmap.md`: one line that `replyTo`
  stays `null` until the next id-format reset. `docs/automations.md`: auto-replies answer the sender.
- CHANGELOG `### Added`: **Replies follow the sender's Reply-To.** … (one paragraph, the house style).
