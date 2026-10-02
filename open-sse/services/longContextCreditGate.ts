/**
 * Anthropic answers a request whose context is beyond what the account may use at
 * the standard rate with `429 "Usage credits are required for long context
 * requests"`. It is a property of THIS request on THIS model — the same account
 * serves other models (and shorter requests) in the same second — not a rate limit,
 * so it must neither cool the account down nor be re-sent as-is.
 *
 * Kept free of imports so the executor layer and the routing layer can share one
 * definition of the wording without a dependency cycle.
 */
export const LONG_CONTEXT_CREDIT_GATE_REGEX = /usage credits are required for long context/i;

export function isLongContextCreditGateError(status: number, errorMessage: string): boolean {
  return status === 429 && LONG_CONTEXT_CREDIT_GATE_REGEX.test(errorMessage);
}
