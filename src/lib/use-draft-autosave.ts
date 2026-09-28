import { useEffect, useRef } from "react";
import {
  fetchDraft,
  saveDraft,
  deleteDraft,
  publishDraft,
  type Draft,
  type CcEntry,
} from "@/lib/api";

/**
 * Shared drafts: after this long without an edit, the saved draft is published
 * to JMAP (a new immutable revision), besides the publish on close.
 */
export const PUBLISH_IDLE_MS = 60_000;

export interface DraftValues {
  fromAddress?: string;
  to?: string;
  cc?: CcEntry[];
  subject?: string;
  bodyHtml?: string;
  bodyText?: string;
  replyToEmailId?: string | null;
  bcc?: CcEntry[];
  keptAttachments?: string[];
  keptAttachmentsRev?: string | null;
  /** Start a new draft on this save (sent once per session, see below). */
  fresh?: boolean;
}

interface UseDraftAutosaveOptions {
  /** Identity of the compose surface: "compose" or `reply:<emailId>`. */
  contextKey: string;
  /** True while the composer is open. Autosave only runs when enabled. */
  enabled: boolean;
  /** Current field values, mirrored on every render. */
  values: DraftValues;
  /**
   * Whether the draft has meaningful content. When false, autosave skips
   * saving and removes any previously saved draft (implicit discard).
   */
  isEmpty: boolean;
  /**
   * Hydrate the composer from a saved draft found on open. Called at most
   * once per open. Skipped entirely when `restore` is false.
   */
  onRestore: (draft: Draft) => void;
  /**
   * Whether to restore a saved draft on open. Callers pass false when the
   * composer opens with an explicit prefill that should win.
   */
  restore: boolean;
  /** Debounce before writing, in ms. */
  debounceMs?: number;
  /** Idle time before publishing to JMAP, in ms. */
  publishIdleMs?: number;
  /**
   * The draft after each publish: part ids of stored attachments renumber
   * with every revision, so the composer refreshes them from here.
   */
  onPublished?: (draft: Draft) => void;
  /**
   * While true (a send is in progress), nothing is saved or published and the
   * close flush is skipped, so nothing races the send's own revision.
   */
  paused?: boolean;
}

/**
 * Autosaves a compose/reply draft to the server, debounced, and restores it
 * when the composer reopens. "Restore on reopen": closing keeps the draft
 * (a final flush runs on close); sending or clearing all fields removes it.
 */
export function useDraftAutosave({
  contextKey,
  enabled,
  values,
  isEmpty,
  onRestore,
  restore,
  debounceMs = 1500,
  publishIdleMs = PUBLISH_IDLE_MS,
  onPublished,
  paused = false,
}: UseDraftAutosaveOptions) {
  const onPublishedRef = useRef(onPublished);
  onPublishedRef.current = onPublished;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  // One generation per open session: a publish that resolves after the
  // composer closed (or moved to another draft) must not touch the next one.
  const generation = useRef(0);
  // A session that didn't restore this surface's draft starts a new one: its
  // first save carries `fresh`, so it never patches a mail-client draft it
  // didn't show (its Bcc or attachments) nor revives a gone one.
  const freshRef = useRef(false);
  // The save in flight, so a send can wait for it (settle()).
  const pendingSave = useRef<Promise<unknown> | null>(null);
  const save = () => {
    const payload = {
      contextKey,
      ...valuesRef.current,
      ...(freshRef.current ? { fresh: true } : {}),
    };
    const request = saveDraft(payload).then((result) => {
      freshRef.current = false;
      return result;
    });
    pendingSave.current = request.catch(() => {});
    return request;
  };
  const publish = () => {
    const session = generation.current;
    return publishDraft(contextKey)
      .then((result) => {
        if (
          result?.draft &&
          session === generation.current &&
          enabledRef.current
        ) {
          onPublishedRef.current?.(result.draft);
        }
      })
      .catch(() => {});
  };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const publishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest render values/flags, read inside async + cleanup callbacks so they
  // never operate on stale closure state.
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const isEmptyRef = useRef(isEmpty);
  isEmptyRef.current = isEmpty;
  const onRestoreRef = useRef(onRestore);
  onRestoreRef.current = onRestore;
  // Whether a row currently exists on the server for this surface.
  const savedRef = useRef(false);
  // Set by clear() (on send) so the close-flush doesn't re-create the draft.
  const clearedRef = useRef(false);

  // Open: optionally restore, and reset the per-open flags.
  useEffect(() => {
    if (!enabled) return;
    generation.current += 1;
    clearedRef.current = false;
    savedRef.current = false;
    freshRef.current = !restore;
    let cancelled = false;
    if (restore) {
      fetchDraft(contextKey)
        .then((draft) => {
          if (cancelled || !draft) return;
          savedRef.current = true;
          onRestoreRef.current(draft);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, contextKey, restore]);

  // Debounced autosave whenever the fields change.
  useEffect(() => {
    if (!enabled) return;
    if (timer.current) clearTimeout(timer.current);
    // Still editing: the idle publish waits for the next save.
    if (publishTimer.current) clearTimeout(publishTimer.current);
    if (paused) return;
    timer.current = setTimeout(() => {
      if (clearedRef.current || pausedRef.current) return;
      if (isEmptyRef.current) {
        // Nothing meaningful left — drop any draft we'd previously saved.
        if (savedRef.current) {
          savedRef.current = false;
          deleteDraft(contextKey).catch(() => {});
        }
        return;
      }
      savedRef.current = true;
      save()
        .then(() => {
          // Publish once the user has stopped editing for a while.
          if (publishTimer.current) clearTimeout(publishTimer.current);
          publishTimer.current = setTimeout(() => {
            if (clearedRef.current || !savedRef.current || pausedRef.current) {
              return;
            }
            void publish();
          }, publishIdleMs);
        })
        .catch(() => {});
    }, debounceMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    isEmpty,
    contextKey,
    values.fromAddress,
    values.to,
    JSON.stringify(values.cc),
    values.subject,
    values.bodyHtml,
    values.bodyText,
    values.replyToEmailId,
    JSON.stringify(values.bcc),
    JSON.stringify(values.keptAttachments),
    values.keptAttachmentsRev,
    paused,
  ]);

  // Close (enabled → false) or surface change: flush the latest state so the
  // last edits aren't lost, and KEEP the draft. If everything's empty, remove
  // any stale row instead. Skipped when clear() already ran (post-send).
  useEffect(() => {
    if (!enabled) return;
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (publishTimer.current) clearTimeout(publishTimer.current);
      // A send in progress owns the draft: no close flush.
      if (clearedRef.current || pausedRef.current) return;
      if (!isEmptyRef.current) {
        savedRef.current = true;
        // Save the last edits, then publish them to JMAP.
        save()
          .then(() => publish())
          .catch(() => {});
      } else if (savedRef.current) {
        savedRef.current = false;
        deleteDraft(contextKey).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, contextKey]);

  /** Delete the draft and suppress the close-flush. Call after a send. */
  function clear() {
    if (timer.current) clearTimeout(timer.current);
    if (publishTimer.current) clearTimeout(publishTimer.current);
    clearedRef.current = true;
    if (savedRef.current) {
      savedRef.current = false;
      deleteDraft(contextKey).catch(() => {});
    }
  }

  /** Wait for a save in flight, so a send never races an older save. */
  async function settle() {
    if (timer.current) clearTimeout(timer.current);
    await pendingSave.current;
  }

  return { clear, settle };
}
