# Review notes: spec/test-mail

Open findings from the last Codex review (2026-10-30 17:04, loop, NEEDS WORK). Written by codex-review after each review; `review-notes --write` rebuilds it
from ~/.local/state/ai-loop/findings.jsonl and `review-notes --recheck` checks them against the code. Tick a box when handled.

- [ ] [P1] `worker/src/routers/admin-inboxes-router.ts:998` — [P1] [worker/src/routers/admin-inboxes-router.ts:998] — If the guarded sparse-row delete misses because another admin changed a field, this request falls through to an upsert using stale values; for example, it overwrites a concurrent `forwardTo` change at [line 1096]. The new race test sets `forwardTo` but only asserts `purpose`. On a missed delete, update only fields named in the PATCH or reread <!-- 6fe99e88af81 -->
- [ ] [P1] `worker/src/lib/test-mail.ts:326` — [P1] [worker/src/lib/test-mail.ts:326] — A 40-message prune pass can collect up to 2,040 R2 keys (50 attachments plus a raw file per message), but one R2 delete call accepts at most 1,000 keys. If exceeded, it fails after the D1 batch deleted the messages, skipping count and audit updates; the next prune cannot retry those rows. Chunk deletes into groups of at most 1,000 and make post-delete accou <!-- 8bc861586abc -->
- [ ] [P2] `worker/src/__tests__/test-inbox-ingest.test.ts:115` — [P2] NOT FIXED — [worker/src/__tests__/test-inbox-ingest.test.ts:115] still tests splitting one plus address separately from ingestion. <!-- e8877a70de9c -->
- [ ] [P2] `worker/src/__tests__/test-inbox-ingest.test.ts:155` — [P2] NOT FIXED — [worker/src/__tests__/test-inbox-ingest.test.ts:155] still checks side-effect helper calls without establishing their configured effects. <!-- cd3ed05167fa -->
- [ ] [P2] `worker/src/__tests__/test-inbox-ingest.test.ts:175` — [P2] NOT FIXED — [worker/src/__tests__/test-inbox-ingest.test.ts:175] still checks helper invocation for the normal-inbox control. <!-- 700bb975c63d -->
