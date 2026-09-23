import type { RuleCondition } from "./types";

export type RuleMessage = {
  fromAddress: string;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  hasAttachments: boolean;
  spamScore: number | null;
  headers: Record<string, string>;
};

export type ConditionResult = {
  condition: RuleCondition;
  matched: boolean;
};

function folded(value: string): string {
  return value.toLowerCase();
}

function textMatches(
  actual: string,
  operator: "equals" | "contains" | "starts_with" | "ends_with",
  expected: string,
): boolean {
  const left = folded(actual);
  const right = folded(expected);
  if (operator === "equals") return left === right;
  if (operator === "contains") return left.includes(right);
  if (operator === "starts_with") return left.startsWith(right);
  return left.endsWith(right);
}

function decodeEntity(entity: string): string | null {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  const lower = entity.toLowerCase();
  if (named[lower] !== undefined) return named[lower];

  if (lower.startsWith("#x")) {
    const code = Number.parseInt(lower.slice(2), 16);
    return Number.isFinite(code) ? String.fromCodePoint(code) : null;
  }
  if (lower.startsWith("#")) {
    const code = Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : null;
  }
  return null;
}

export function htmlToText(html: string): string {
  let result = "";
  let inTag = false;

  for (let index = 0; index < html.length; index += 1) {
    const char = html[index];
    if (char === "<") {
      inTag = true;
      if (result.length > 0 && !result.endsWith(" ")) result += " ";
      continue;
    }
    if (char === ">" && inTag) {
      inTag = false;
      continue;
    }
    if (inTag) continue;

    if (char === "&") {
      const end = html.indexOf(";", index + 1);
      if (end !== -1 && end - index <= 12) {
        const decoded = decodeEntity(html.slice(index + 1, end));
        if (decoded !== null) {
          result += decoded;
          index = end;
          continue;
        }
      }
    }
    result += char;
  }

  let normalized = "";
  let pendingSpace = false;
  for (const char of result) {
    if (char.trim() === "") {
      pendingSpace = normalized.length > 0;
      continue;
    }
    if (pendingSpace) normalized += " ";
    normalized += char;
    pendingSpace = false;
  }
  return normalized;
}

function headerValue(
  headers: Record<string, string>,
  name: string,
): string | null {
  const target = folded(name);
  for (const [key, value] of Object.entries(headers)) {
    if (folded(key) === target) return value;
  }
  return null;
}

export function matchCondition(
  condition: RuleCondition,
  message: RuleMessage,
): boolean {
  switch (condition.field) {
    case "from_address":
      return textMatches(
        message.fromAddress,
        condition.operator,
        condition.value,
      );
    case "from_domain": {
      const at = message.fromAddress.lastIndexOf("@");
      if (at === -1) return false;
      return textMatches(
        message.fromAddress.slice(at + 1),
        "equals",
        condition.value,
      );
    }
    case "subject":
      return textMatches(
        message.subject ?? "",
        condition.operator,
        condition.value,
      );
    case "body":
      return textMatches(
        message.bodyText ?? htmlToText(message.bodyHtml ?? ""),
        "contains",
        condition.value,
      );
    case "has_attachments":
      return message.hasAttachments === condition.value;
    case "spam_score":
      if (message.spamScore === null) return false;
      return condition.operator === "gte"
        ? message.spamScore >= condition.value
        : message.spamScore <= condition.value;
    case "header": {
      const value = headerValue(message.headers, condition.name);
      return (
        value !== null &&
        textMatches(value, condition.operator, condition.value)
      );
    }
  }
}

export function matchConditions(
  conditions: RuleCondition[],
  message: RuleMessage,
): { matched: boolean; conditionResults: ConditionResult[] } {
  const conditionResults = conditions.map((condition) => ({
    condition,
    matched: matchCondition(condition, message),
  }));
  return {
    matched: conditionResults.every((result) => result.matched),
    conditionResults,
  };
}
