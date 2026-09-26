import type { JmapMethodError } from "./emails";

export type OnSuccessMode = "none" | "update" | "destroy" | "both";

export type ParsedOnSuccess = {
  update: Record<string, Record<string, unknown>> | null;
  destroy: string[] | null;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Worker `strict` is off, so narrow method errors through a guard. */
export function isMethodError(value: unknown): value is JmapMethodError {
  return (
    isObject(value) && typeof value.type === "string" && !("accountId" in value)
  );
}

/** RFC 8621 §7.5 arguments; malformed values fail the whole call. */
export function parseOnSuccessArgs(
  args: Record<string, unknown>,
): ParsedOnSuccess | JmapMethodError {
  const update = args.onSuccessUpdateEmail;
  const destroy = args.onSuccessDestroyEmail;
  if (
    update !== undefined &&
    update !== null &&
    (!isObject(update) || !Object.values(update).every(isObject))
  ) {
    return { type: "invalidArguments", properties: ["onSuccessUpdateEmail"] };
  }
  if (
    destroy !== undefined &&
    destroy !== null &&
    (!Array.isArray(destroy) ||
      !destroy.every((value) => typeof value === "string"))
  ) {
    return { type: "invalidArguments", properties: ["onSuccessDestroyEmail"] };
  }
  return {
    update: (update ?? null) as Record<string, Record<string, unknown>> | null,
    destroy: (destroy ?? null) as string[] | null,
  };
}

/**
 * What one create stores on its intention (spec §3.4 step 1). Only
 * `#creationId` keys can name a submission created in this call; keys naming an
 * existing submission never apply (see the plan's Decision 4).
 */
export function onSuccessForCreation(
  parsed: ParsedOnSuccess,
  creationId: string,
): { mode: OnSuccessMode; patch: Record<string, unknown> | null } {
  const key = `#${creationId}`;
  const patch = parsed.update?.[key] ?? null;
  const destroy = parsed.destroy?.includes(key) ?? false;
  const mode: OnSuccessMode =
    patch && destroy ? "both" : patch ? "update" : destroy ? "destroy" : "none";
  return { mode, patch };
}

/** Either argument present: the call answers with an implicit Email/set. */
export function wantsImplicitEmailSet(parsed: ParsedOnSuccess): boolean {
  return parsed.update !== null || parsed.destroy !== null;
}
