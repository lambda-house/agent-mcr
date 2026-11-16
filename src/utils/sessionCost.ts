import type { Session } from './sessions';
// Standard USD / million tokens: input, output, cached input.
// https://platform.claude.com/docs/en/about-claude/pricing (2026-11-16).
// Exact model families only: never price an unknown model as a similar one.
const rates: Record<string, [number, number, number]> = {
  'claude-opus-4-5': [5, 25, .5], 'claude-opus-4-6': [5, 25, .5],
  'claude-opus-4-7': [5, 25, .5], 'claude-opus-4-8': [5, 25, .5],
  'claude-opus-5': [5, 25, .5], 'claude-opus-5-5': [4, 20, .2],
  'claude-sonnet-4-5': [3, 15, .3], 'claude-sonnet-4-6': [3, 15, .3],
  'claude-sonnet-5': [2, 10, .2], 'claude-sonnet-5-5': [2, 10, .1],
  'claude-haiku-4-5': [1, 5, .1],
};
export function estimatedCost(s: Session): number | null {
  if (!s.usageKnown || s.provider !== 'claude' || !Object.keys(s.models).length) return null;
  let total = 0;
  for (const [model, u] of Object.entries(s.models)) {
    const r = rates[model.replace(/-\d{8}$/, '')];
    if (!r || [u.input, u.output, u.cached, u.cacheWrite].some(n => !Number.isFinite(n) || n < 0) || u.cached + u.cacheWrite > u.input) return null;
    // The index normalizes Claude input to INCLUDE both cache categories.
    total += ((u.input - u.cached - u.cacheWrite) * r[0] + u.cached * r[2] + u.cacheWrite * r[0] * 1.25 + u.output * r[1]) / 1_000_000;
  }
  return total;
}
