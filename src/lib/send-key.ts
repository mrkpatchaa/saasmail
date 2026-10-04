/**
 * Idempotency keys of the web composers. A compose window sends the same key
 * on every attempt of one message, so a retry after a timeout never sends it
 * twice; a successful send forgets the key and the next message gets a new
 * one. Kept in sessionStorage per compose context ("compose", "reply:<id>",
 * …), so reloading the tab in the middle of a retry reuses it.
 */
const PREFIX = "saasmail:send-key:";
// When sessionStorage is unavailable (private mode, blocked storage).
const memory = new Map<string, string>();

export function sendKeyFor(context: string): string {
  try {
    const stored = sessionStorage.getItem(PREFIX + context);
    if (stored) return stored;
  } catch {
    // Fall back to memory.
  }
  const key = memory.get(context) ?? crypto.randomUUID();
  memory.set(context, key);
  try {
    sessionStorage.setItem(PREFIX + context, key);
  } catch {
    // Memory still has it.
  }
  return key;
}

export function forgetSendKey(context: string): void {
  memory.delete(context);
  try {
    sessionStorage.removeItem(PREFIX + context);
  } catch {
    // Nothing stored.
  }
}

/**
 * What to tell the user when a send was refused because of its key, or null
 * for any other failure. A key already used for a different message means an
 * earlier attempt from this window went through without the window learning
 * it: the key is replaced so that sending again sends the message as it is
 * now, and the user is told to check Sent first.
 */
export function sendKeyProblem(error: unknown, context: string): string | null {
  // An ApiError carries the server's code; read it by shape, so this works
  // wherever the API module is replaced (tests).
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "IDEMPOTENCY_KEY_REUSED") {
    forgetSendKey(context);
    return "An earlier attempt from this window was already sent. Check Sent before sending again.";
  }
  if (code === "IDEMPOTENCY_IN_PROGRESS") {
    return "The previous attempt is still sending. Try again in a moment.";
  }
  return null;
}
