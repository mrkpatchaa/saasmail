/** Counts the filter keeps for one token. */
export interface TokenCounts {
  spamCount: number;
  hamCount: number;
}

/** How many junk and not-junk messages an inbox's filter was trained on. */
export interface ModelCounts {
  spamMessages: number;
  hamMessages: number;
}

/** Messages of each label a filter needs before it scores. */
export const MIN_TRAINING_MESSAGES = 20;
/** Tokens that decide a score: the most telling ones. */
const INTERESTING_TOKENS = 15;
/** Below this many known tokens there is not enough evidence. */
const MIN_KNOWN_TOKENS = 5;

/** Whether a filter has enough training to score new mail. */
export function modelReady(model: ModelCounts): boolean {
  return (
    model.spamMessages >= MIN_TRAINING_MESSAGES &&
    model.hamMessages >= MIN_TRAINING_MESSAGES
  );
}

/**
 * The probability that a message is junk, from its tokens' counts (Graham's
 * "A Plan for Spam"): each known token's junk probability, with not-junk
 * counts doubled to bias against false positives and clamped to
 * [0.01, 0.99]; the 15 farthest from 0.5 combined. Null with fewer than five
 * known tokens. Pure.
 */
export function score(
  tokens: string[],
  counts: Map<string, TokenCounts>,
  model: ModelCounts,
): number | null {
  if (model.spamMessages === 0 || model.hamMessages === 0) return null;
  const probabilities: number[] = [];
  for (const token of tokens) {
    const count = counts.get(token);
    if (!count || count.spamCount + count.hamCount < 1) continue;
    const bad = Math.min(1, count.spamCount / model.spamMessages);
    const good = Math.min(1, (2 * count.hamCount) / model.hamMessages);
    if (bad + good === 0) continue;
    probabilities.push(Math.min(0.99, Math.max(0.01, bad / (bad + good))));
  }
  if (probabilities.length < MIN_KNOWN_TOKENS) return null;

  const telling = probabilities
    .sort((a, b) => Math.abs(b - 0.5) - Math.abs(a - 0.5))
    .slice(0, INTERESTING_TOKENS);
  // Π p / (Π p + Π (1 − p)), in log space so many small factors stay exact.
  let logSpam = 0;
  let logHam = 0;
  for (const p of telling) {
    logSpam += Math.log(p);
    logHam += Math.log(1 - p);
  }
  return 1 / (1 + Math.exp(logHam - logSpam));
}
