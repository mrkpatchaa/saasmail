import { createAuthMiddleware, isAPIError } from "better-auth/api";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { userActor } from "../lib/audit/actors";
import { runWithAudit } from "../lib/audit/context";
import { AUDIT_ACTIONS } from "../lib/audit/events";
import { recordAudit } from "../lib/audit/record";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/**
 * What an after-hook sees of a finished better-auth request. Kept loose on
 * purpose: only the few fields read here, all optional, so a library upgrade
 * that moves one degrades to "not recorded" rather than a failed sign-in.
 */
export interface AuthHookContext {
  path?: string;
  body?: Record<string, unknown> | null;
  query?: Record<string, unknown> | null;
  request?: Request;
  context?: {
    returned?: unknown;
    newSession?: { user?: AuthUser | null } | null;
    session?: { user?: AuthUser | null } | null;
  };
}

type AuthUser = { id: string; email?: string | null; name?: string | null };

const SIGN_IN_METHOD: Record<string, string> = {
  "/sign-in/email": "password",
  "/passkey/verify-authentication": "passkey",
};

const text = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

function failed(returned: unknown): boolean {
  if (isAPIError(returned) || returned instanceof Error) return true;
  return returned instanceof Response && returned.status >= 400;
}

/**
 * Records sign-ins, passkey changes and OAuth client and consent changes.
 * These requests go to better-auth directly and pass no route of ours, so
 * this hook is the only place they can be seen.
 */
export async function auditAuthRequest(
  db: Db,
  ctx: AuthHookContext,
): Promise<void> {
  const path = ctx.path;
  if (!path) return;
  const returned = ctx.context?.returned;
  const ok = !failed(returned);
  const sessionUser =
    ctx.context?.newSession?.user ?? ctx.context?.session?.user ?? null;
  const asUser = <T>(user: AuthUser, fn: () => Promise<T>) =>
    runWithAudit(userActor(user, ctx.request), fn);

  const method = SIGN_IN_METHOD[path];
  if (method) {
    const user = ctx.context?.newSession?.user;
    if (ok && user) {
      await asUser(user, () =>
        recordAudit(db, {
          action: AUDIT_ACTIONS.authSignIn,
          targetType: "user",
          targetId: user.id,
          summary: `Signed in with a ${method}`,
          details: { method },
        }),
      );
    } else if (!ok) {
      // Nobody is signed in: the attempt is recorded with the address that
      // was tried, when the request named one.
      const email = text(ctx.body?.email)?.toLowerCase() ?? null;
      await recordAudit(db, {
        action: AUDIT_ACTIONS.authSignInFailed,
        targetType: "user",
        summary: email
          ? `Failed ${method} sign-in for ${email}`
          : `Failed ${method} sign-in`,
        details: { method, ...(email ? { email } : {}) },
      });
    }
    return;
  }

  if (!ok) return;

  if (path === "/passkey/verify-registration" && sessionUser) {
    await asUser(sessionUser, () =>
      recordAudit(db, {
        action: AUDIT_ACTIONS.userPasskeyAdded,
        targetType: "user",
        targetId: sessionUser.id,
        summary: "Registered a passkey",
      }),
    );
  } else if (path === "/passkey/delete-passkey" && sessionUser) {
    await asUser(sessionUser, () =>
      recordAudit(db, {
        action: AUDIT_ACTIONS.userPasskeyRemoved,
        targetType: "user",
        targetId: sessionUser.id,
        summary: "Removed a passkey",
        details: { passkeyId: text(ctx.body?.id) },
      }),
    );
  } else if (path === "/oauth2/register") {
    const client = (returned ?? {}) as Record<string, unknown>;
    const clientId = text(client.client_id);
    const name =
      text(client.client_name) ?? text(ctx.body?.client_name) ?? clientId;
    await recordAudit(db, {
      action: AUDIT_ACTIONS.oauthClientRegistered,
      targetType: "oauth_client",
      targetId: clientId,
      summary: `An OAuth client registered itself: ${name ?? "unnamed"}`,
      details: { clientId, name },
    });
  } else if (path === "/oauth2/consent" && sessionUser) {
    if (ctx.body?.accept !== true) return;
    await asUser(sessionUser, () =>
      recordAudit(db, {
        action: AUDIT_ACTIONS.oauthConsentGranted,
        targetType: "oauth_client",
        summary: "Granted an OAuth client access to their account",
        details: { scope: text(ctx.body?.scope) },
      }),
    );
  } else if (path === "/oauth2/delete-consent" && sessionUser) {
    await asUser(sessionUser, () =>
      recordAudit(db, {
        action: AUDIT_ACTIONS.oauthConsentRevoked,
        targetType: "oauth_client",
        targetId: text(ctx.body?.id),
        summary: "Withdrew an OAuth client's access to their account",
      }),
    );
  }
}

/** The `hooks.after` of the auth configuration. Never fails the request. */
export function auditAfterHook(db: Db) {
  return createAuthMiddleware(async (ctx) => {
    try {
      await auditAuthRequest(db, ctx as unknown as AuthHookContext);
    } catch (error) {
      console.warn("[audit] auth event not recorded:", error);
    }
  });
}
