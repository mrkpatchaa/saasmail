import { useState, useEffect, useMemo } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { PenSquare, Send, X } from "lucide-react";
import TiptapEditor from "@/components/TiptapEditor";
import CcInput from "@/components/CcInput";
import {
  TrayMaximizeButton,
  TrayMetaRow,
  trayContentClass,
} from "@/components/Tray";
import {
  SendDraftError,
  sendDraft,
  sendEmail,
  fetchStats,
  type CcEntry,
  type Draft,
  type StoredAttachment,
} from "@/lib/api";
import { useDraftAutosave } from "@/lib/use-draft-autosave";
import { dispatchEmailSent } from "@/lib/email-events";
import { getFromLabel } from "@/lib/format";
import { sanitizeEmailHtml } from "@/lib/sanitize-html";
import AttachmentPicker from "@/components/AttachmentPicker";
import AttachmentChips from "@/components/AttachmentChips";

// Effective backend cap is ~18MB on the Cloudflare email path; we cap the
// UI at 25MB and let the server reject the rest with a clear 413.
const ATTACHMENT_CAP_BYTES = 25 * 1024 * 1024;

/**
 * Optional seed values applied when the compose drawer opens. Used by
 * the chat-mode "open in compose" handoff so a user can switch from
 * the bottom-of-thread quick reply to the full editor without losing
 * context (sender, recipient, CC roster, subject).
 *
 * Any field omitted falls back to the drawer's regular default —
 * `from` defaults to the user's first inbox; `to`/`cc`/`subject`/`bodyHtml`
 * default to empty.
 */
export interface ComposePrefill {
  from?: string;
  to?: string;
  cc?: CcEntry[];
  subject?: string;
  bodyHtml?: string;
}

interface ComposeModalProps {
  open: boolean;
  onClose: () => void;
  prefill?: ComposePrefill | null;
  contextKey?: string;
}

/**
 * Compose drawer — opens from the right edge to match ReplyComposer.
 * Single "Freeform" mode for now (no template support); structurally
 * mirrors the reply experience so the two feel like the same component.
 */
export default function ComposeModal({
  open,
  onClose,
  prefill,
  contextKey = "compose",
}: ComposeModalProps) {
  const [to, setTo] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [cc, setCc] = useState<CcEntry[]>([]);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [senderIdentities, setSenderIdentities] = useState<
    Array<{
      email: string;
      displayName: string | null;
      signatureHtml: string | null;
    }>
  >([]);
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  // Plain-text rendering of the editor, kept in lockstep with bodyHtml so the
  // outgoing mail ships a `text/plain` part — same shape the reply composers
  // send. Also what the chat feed keys off to render a normal bubble rather
  // than the HTML preview card.
  const [bodyText, setBodyText] = useState("");
  // Tracked separately from the body so swapping `From` mid-compose can swap
  // the signature without stomping on what the user has typed.
  const [signatureHtml, setSignatureHtml] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  // Shared drafts: parts of a mail-client draft this composer can't show yet,
  // and whether the draft was sent or deleted from a mail client.
  const [jmapExtras, setJmapExtras] = useState<string[]>([]);
  const [jmapGone, setJmapGone] = useState(false);
  // Shared drafts: Bcc, and the attachments a mail-client draft already
  // carries (null until a saved draft says; then the ones kept).
  const [bcc, setBcc] = useState<CcEntry[]>([]);
  const [showBcc, setShowBcc] = useState(false);
  const [stored, setStored] = useState<StoredAttachment[] | null>(null);
  // The JMAP revision `stored` part ids belong to (they renumber on publish).
  const [storedRev, setStoredRev] = useState<string | null>(null);
  // Compact tray vs. full-viewport. Toggled by the maximize button in
  // the header; reset every time the drawer reopens.
  const [fullscreen, setFullscreen] = useState(false);

  // Domains we own — used for the lime/neutral CC chip color.
  const internalDomains = useMemo(() => {
    const set = new Set<string>();
    for (const s of senderIdentities) {
      const at = s.email.lastIndexOf("@");
      if (at >= 0) set.add(s.email.slice(at + 1).toLowerCase());
    }
    return Array.from(set);
  }, [senderIdentities]);

  // TipTap emits "<p></p>" for an empty editor — treat that as empty.
  const bodyIsEmpty = !bodyHtml || bodyHtml === "<p></p>";

  const totalAttachmentBytes = files.reduce((s, f) => s + f.size, 0);

  // Sanitize the signature once per change, then reuse for both the
  // preview pane and the outbound concatenation. The server also
  // sanitizes on write — this is defense-in-depth for browser
  // execution paths (preview pane uses dangerouslySetInnerHTML).
  const safeSignatureHtml = useMemo(
    () => (signatureHtml ? sanitizeEmailHtml(signatureHtml) : null),
    [signatureHtml],
  );

  useEffect(() => {
    if (open) {
      fetchStats().then((stats) => {
        setRecipients(stats.recipients);
        setSenderIdentities(stats.senderIdentities ?? []);
        // Prefill `from` wins; otherwise keep whatever was sticky from
        // last open; finally fall back to the first inbox.
        const want = prefill?.from;
        if (want && stats.recipients.includes(want)) {
          setFromAddress(want);
        } else if (!fromAddress && stats.recipients.length > 0) {
          setFromAddress(stats.recipients[0]);
        }
      });
      // Apply any seeded values up front. Fields the caller didn't
      // specify stay empty — same as a fresh "Compose" click.
      setTo(prefill?.to ?? "");
      setCc(prefill?.cc ?? []);
      setSubject(prefill?.subject ?? "");
      setBodyHtml(prefill?.bodyHtml ?? "");
      setBodyText("");
    } else {
      setTo("");
      setCc([]);
      setSubject("");
      setBodyHtml("");
      setBodyText("");
      setSignatureHtml(null);
      setError("");
      setFullscreen(false);
      setJmapExtras([]);
      setJmapGone(false);
      setBcc([]);
      setShowBcc(false);
      setStored(null);
      setStoredRev(null);
      setFiles([]);
    }
    // We intentionally don't track `fromAddress` here — it's only used
    // as a sticky fallback above, not as a trigger to re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefill]);

  // Whenever the From inbox or the loaded identity list changes, swap the
  // signature trail to match. Stays a separate state slot so the user's
  // typed body never gets clobbered.
  useEffect(() => {
    if (!fromAddress) {
      setSignatureHtml(null);
      return;
    }
    const match = senderIdentities.find((s) => s.email === fromAddress);
    setSignatureHtml(match?.signatureHtml ?? null);
  }, [fromAddress, senderIdentities]);

  // Autosave a "half-written" draft so it survives closing the composer.
  // Restore only on a plain open — an explicit prefill (e.g. the chat
  // "open in compose" handoff) should win over a stale draft.
  // A draft linked to a mail-client draft is never "empty": only an explicit
  // delete may remove it (an attachment-only draft has no To or body).
  const composeIsEmpty =
    storedRev === null &&
    !to.trim() &&
    !subject.trim() &&
    bodyIsEmpty &&
    !bodyText.trim() &&
    cc.length === 0 &&
    bcc.length === 0 &&
    (stored?.length ?? 0) === 0;
  // A draft opened from a mail client carries its own signature, if any.
  const fromMailClient = contextKey.startsWith("jmap:");
  const effectiveSignatureHtml = fromMailClient ? null : safeSignatureHtml;
  function applyDraftState(draft: Draft) {
    setJmapExtras(draft.jmapExtras ?? []);
    setJmapGone(draft.jmapState === "gone");
    setStored(draft.storedAttachments ?? []);
    setStoredRev(draft.storedAttachmentsRev ?? null);
  }
  const hasPrefill = !!(
    prefill &&
    (prefill.to ||
      prefill.subject ||
      prefill.bodyHtml ||
      (prefill.cc && prefill.cc.length > 0))
  );
  const { clear: clearDraft } = useDraftAutosave({
    contextKey,
    enabled: open,
    isEmpty: composeIsEmpty,
    restore: open && !hasPrefill,
    values: {
      fromAddress,
      to,
      cc,
      subject,
      bodyHtml,
      bodyText,
      bcc,
      ...(stored
        ? {
            keptAttachments: stored.map((part) => part.partId),
            keptAttachmentsRev: storedRev,
          }
        : {}),
    },
    paused: sending,
    onPublished: applyDraftState,
    onRestore: (draft) => {
      applyDraftState(draft);
      setBcc(draft.bcc ?? []);
      setShowBcc((draft.bcc?.length ?? 0) > 0);
      if (draft.toAddress) setTo(draft.toAddress);
      if (draft.cc) setCc(draft.cc);
      if (draft.subject) setSubject(draft.subject);
      if (draft.bodyHtml) setBodyHtml(draft.bodyHtml);
      if (draft.bodyText) setBodyText(draft.bodyText);
      if (draft.fromAddress) setFromAddress(draft.fromAddress);
    },
  });

  async function handleSend() {
    if (!to || bodyIsEmpty) return;
    setSending(true);
    setError("");
    try {
      // Concatenate the typed body + auto-attached signature on send.
      // The signature is wrapped in `data-signature` so the chat-feed
      // toggle can strip it back out cleanly.
      // Use the sanitized signature — even the outbound payload that
      // never touches the browser DOM gets the cleaned version.
      const finalBody = effectiveSignatureHtml
        ? `${bodyHtml}<div data-signature>${effectiveSignatureHtml}</div>`
        : bodyHtml;
      // Shared drafts: send the draft the way a mail client would, so the
      // same Email is filed into Sent and everything it carries goes out.
      const attached = files.map((file) => ({ file }));
      const { fallback } = await sendDraft(
        {
          contextKey,
          fromAddress,
          to,
          ...(cc.length > 0 ? { cc } : {}),
          bcc,
          ...(stored
            ? {
                keptAttachments: stored.map((part) => part.partId),
                keptAttachmentsRev: storedRev,
              }
            : {}),
          subject,
          // The draft keeps the body as typed; the signature goes on the sent
          // message only.
          bodyHtml,
          ...(effectiveSignatureHtml
            ? { signatureHtml: effectiveSignatureHtml }
            : {}),
          ...(bodyText.trim() ? { bodyText } : {}),
        },
        attached,
      );
      if (fallback) {
        if (
          bcc.length > 0 ||
          (stored?.length ?? 0) > 0 ||
          /[,;]/.test(to.trim())
        ) {
          throw new Error(
            "This inbox can only send through the direct route, which sends to one To address without Bcc or stored attachments",
          );
        }
        // This inbox can't send through JMAP: the direct route.
        await sendEmail({
          to,
          fromAddress,
          ...(cc.length > 0 ? { cc } : {}),
          subject,
          bodyHtml: finalBody,
          ...(bodyText.trim() ? { bodyText } : {}),
          ...(files.length > 0 ? { files: attached } : {}),
        });
      }
      dispatchEmailSent({ fromAddress, to, origin: "compose" });
      // The message went out — discard its draft so it doesn't reappear.
      clearDraft();
      setFiles([]);
      onClose();
    } catch (err) {
      // A refused send may have saved the new files into the draft: show them
      // as stored and don't attach them again.
      if (err instanceof SendDraftError && err.draft) {
        applyDraftState(err.draft);
        setFiles([]);
      }
      setError(
        err instanceof Error &&
          err.message &&
          !err.message.startsWith("API error")
          ? err.message
          : "Failed to send email",
      );
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  }

  if (!open) return null;

  return (
    // Non-modal tray (Gmail-style): the inbox stays clickable behind the
    // compose window, only the close button or Esc dismisses, and the
    // tray is anchored to the bottom-right.
    <DialogPrimitive.Root
      open
      modal={false}
      onOpenChange={(v) => !v && !sending && onClose()}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="tray-overlay fixed inset-0 z-50" />
        <DialogPrimitive.Content
          onKeyDown={handleKeyDown}
          onInteractOutside={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          className={trayContentClass({ fullscreen, width: "compose" })}
        >
          {/* Slim single-row header — title + max/close. */}
          <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-3 pl-4">
            <div className="flex min-w-0 items-center gap-2">
              <PenSquare
                size={13}
                className="shrink-0"
                style={{ color: "#7c5cfc" }}
                aria-hidden
              />
              <DialogPrimitive.Title className="truncate text-sm font-semibold text-text-primary">
                {to ? `New message · ${to}` : "New message"}
              </DialogPrimitive.Title>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <TrayMaximizeButton
                fullscreen={fullscreen}
                onToggle={() => setFullscreen((v) => !v)}
              />
              <DialogPrimitive.Close
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
                aria-label="Close"
              >
                <X size={14} />
              </DialogPrimitive.Close>
            </div>
          </div>

          {/* Compact metadata: From / To / Cc / Subject. Each field is
              a single inline row with no grid label column — keeps the
              chrome closer to ~150px so the body has more room. */}
          <div
            className="shrink-0 divide-y divide-border/60 border-b border-border bg-bg-subtle/30"
            data-testid="compose-metadata"
          >
            <TrayMetaRow label="From">
              <select
                value={fromAddress}
                onChange={(e) => setFromAddress(e.target.value)}
                required
                className="w-full bg-transparent py-2 pr-3 text-sm text-text-primary outline-none"
              >
                {recipients.map((r) => (
                  <option key={r} value={r}>
                    {getFromLabel(r, senderIdentities)}
                  </option>
                ))}
              </select>
            </TrayMetaRow>
            <TrayMetaRow label="To" htmlFor="compose-to">
              <input
                id="compose-to"
                type="email"
                multiple
                value={to}
                onChange={(e) => setTo(e.target.value)}
                required
                placeholder="recipient@example.com, another@example.com"
                aria-label="To"
                className="w-full bg-transparent py-2 pr-3 text-sm text-text-primary outline-none placeholder:text-text-tertiary"
              />
            </TrayMetaRow>
            <TrayMetaRow label="Cc">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <CcInput
                    value={cc}
                    onChange={setCc}
                    internalDomains={internalDomains}
                    testId="compose-cc-input"
                  />
                </div>
                {!showBcc && (
                  <button
                    type="button"
                    data-testid="compose-show-bcc"
                    onClick={() => setShowBcc(true)}
                    className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-text-tertiary hover:bg-bg-muted hover:text-text-primary"
                  >
                    Bcc
                  </button>
                )}
              </div>
            </TrayMetaRow>
            {showBcc && (
              <TrayMetaRow label="Bcc">
                <CcInput
                  value={bcc}
                  onChange={setBcc}
                  internalDomains={internalDomains}
                  placeholder="Add Bcc — Enter to confirm"
                  testId="compose-bcc-input"
                />
              </TrayMetaRow>
            )}
            <TrayMetaRow label="Subject" htmlFor="compose-subject">
              <input
                id="compose-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                required
                placeholder="What's it about?"
                aria-label="Subject"
                className="w-full bg-transparent py-2 pr-3 text-sm text-text-primary outline-none placeholder:text-text-tertiary"
              />
            </TrayMetaRow>
          </div>

          {/* Body — no min-height, just flex-1 so the editor fills the
              tray. The smooth-scroll wrapper keeps long drafts scrollable. */}
          <div
            className="smooth-scroll flex min-h-0 flex-1 flex-col overflow-y-auto bg-card px-4 py-3 sm:px-5"
            data-testid="compose-body"
          >
            <AttachmentPicker
              enableDragDrop
              buttonClassName="hidden"
              onFilesAdded={(added) => setFiles((prev) => [...prev, ...added])}
            >
              <TiptapEditor
                content={bodyHtml}
                onUpdate={(html, text) => {
                  setBodyHtml(html);
                  setBodyText(text);
                }}
              />
              {stored && stored.length > 0 && (
                <div
                  className="flex flex-wrap items-center gap-1.5 px-2 pt-1.5"
                  data-testid="compose-stored-attachments"
                >
                  {stored.map((part) => (
                    <span
                      key={part.partId}
                      data-testid="compose-stored-attachment"
                      className="inline-flex items-center gap-1 rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-700"
                    >
                      {part.name ?? part.type}
                      <button
                        type="button"
                        aria-label={`Remove ${part.name ?? part.type}`}
                        onClick={() =>
                          setStored((prev) =>
                            (prev ?? []).filter(
                              (item) => item.partId !== part.partId,
                            ),
                          )
                        }
                        className="rounded-full p-0.5 hover:bg-gray-200"
                      >
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <AttachmentChips
                files={files}
                capBytes={ATTACHMENT_CAP_BYTES}
                onRemove={(idx) =>
                  setFiles((prev) => prev.filter((_, i) => i !== idx))
                }
              />
              {effectiveSignatureHtml && (
                <div
                  data-signature
                  data-testid="compose-signature-preview"
                  className="mt-4 border-t border-border/60 pt-3 opacity-70"
                  // Read-only signature preview. Auto-attached at send time;
                  // edited via the admin Inboxes page rather than inline.
                  // Pre-sanitized via sanitizeEmailHtml — see safeSignatureHtml.
                  dangerouslySetInnerHTML={{ __html: effectiveSignatureHtml }}
                />
              )}
            </AttachmentPicker>
          </div>

          {(jmapExtras.length > 0 || jmapGone) && (
            <div
              data-testid="compose-shared-draft-notice"
              className="shrink-0 border-t border-border bg-amber-50 px-4 py-2 text-[11px] text-amber-800 sm:px-5"
            >
              {jmapGone
                ? "This draft was sent or deleted from a mail client. Changes here are no longer saved there."
                : `This draft also has ${jmapExtras.join(", ")}, which this composer can't show yet. They are kept when you edit it, and sent with it.`}
            </div>
          )}

          {/* Slim footer — single row, just send + cancel + hint. */}
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-card px-4 py-2.5 sm:px-5">
            <div className="min-w-0 truncate text-[11px] font-light text-text-tertiary">
              {error ? (
                <span className="text-destructive" role="alert">
                  {error}
                </span>
              ) : (
                <span className="hidden sm:inline">
                  <kbd className="rounded border border-border bg-bg-muted px-1 font-mono text-[10px]">
                    ⌘
                  </kbd>
                  <kbd className="ml-1 rounded border border-border bg-bg-muted px-1 font-mono text-[10px]">
                    Enter
                  </kbd>{" "}
                  to send
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <AttachmentPicker
                onFilesAdded={(added) =>
                  setFiles((prev) => [...prev, ...added])
                }
                buttonClassName="inline-flex items-center justify-center rounded-[6px] p-1.5 text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
              />
              <button
                type="button"
                onClick={onClose}
                disabled={sending}
                className="rounded-[6px] border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="compose-send-button"
                onClick={handleSend}
                disabled={
                  sending ||
                  bodyIsEmpty ||
                  !to ||
                  totalAttachmentBytes > ATTACHMENT_CAP_BYTES ||
                  jmapGone
                }
                className="inline-flex items-center gap-1.5 rounded-[6px] bg-text-primary px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-colors hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Send size={12} />
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
