import { useEffect, useState } from 'react';
import { Flame } from 'lucide-react';
import { cacheState, compact, contextWindow, sessionApi, sessionKey, type Session } from '../utils/sessions';
import { runningFor, type Hosted } from '../utils/harness';
import { estimatedCost } from '../utils/sessionCost';

/** One index refresh for the entire sidebar, never one scan per row. */
export function useSessionMetrics(active: boolean) {
  const [data, setData] = useState<Record<string, Session>>({});
  useEffect(() => {
    if (!active) return;
    let live = true, pending = false;
    const load = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try {
        const snapshot = await sessionApi.snapshot();
        if (live) setData(Object.fromEntries(snapshot.sessions.map(s => [sessionKey(s), s])));
      } catch { if (live) setData({}); }
      finally { pending = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => { live = false; clearInterval(timer); };
  }, [active]);
  return data;
}

const STALE_MS = 5 * 60_000;

/** The indexed conversation of a hosted session, when the Sessions index has it. */
export function indexedSession(hosted: Hosted, data: Record<string, Session>): Session | undefined {
  const provider = hosted.harness?.profile || hosted.meta.profile;
  if (provider !== 'claude' && provider !== 'codex') return undefined;
  return data[`${provider}:${hosted.harness?.agentSession || ''}`];
}

/** The row class of a live session by its prompt cache: glowing while warm, ashes once cold. */
export function cacheClass(hosted: Hosted, data: Record<string, Session>, now: number): string {
  const s = hosted.exit ? undefined : indexedSession(hosted, data);
  const cache = s && cacheState(s, now);
  if (!cache) return '';
  // A session at work refreshes its cache with every request, whatever the index last saw
  if (cache.warm || hosted.harness?.state === 'working') return cache.cooling ? 'cache-warm cache-cooling' : 'cache-warm';
  return 'cache-cold';
}

/** Every figure of the row, spelled out: the row itself shows bare numbers. */
export function metricsTooltip(s: Session, cost: number | null, now: number): string {
  const c = s.context;
  const lines: string[] = [];
  if (c && c.now > 0) {
    const limit = contextWindow(s);
    lines.push(`Context: ${compact(c.now)}${limit
      ? ` of ${compact(limit.size)} tokens (${Math.round(100 * c.now / limit.size)}%)${limit.assumed ? '; the limit is assumed, Claude Code does not record it (200K, or 1M once a session has held more)' : ''}`
      : ' tokens; the context limit is not reported'}`);
    lines.push(`  input of the latest reply, not lifetime usage${c.first > 0 ? ` · at start ${compact(c.first)}` : ''}${c.peak > 0 ? ` · peak ${compact(c.peak)}` : ''}`);
  } else lines.push('Context: not recorded yet');
  if (c) lines.push(`Compactions: ${c.compactions} (seen in the indexed transcript; missing or copied history can affect the count)`);
  const cache = cacheState(s, now);
  if (cache) {
    const life = cache.ttl >= 3600 ? `${cache.ttl / 3600} h` : `${cache.ttl / 60} min`;
    lines.push(cache.warm
      ? `Cache: warm for another ${runningFor(now, cache.until)} (${life} cache, refreshed by every request)`
      : `Cache: cold for ${runningFor(cache.until, now)}. Waking the session up writes about ${compact(c?.now ?? 0)} tokens to the cache again`);
    if (c?.coldWakeups) lines.push(`Cold wakeups so far: ${c.coldWakeups} · ${compact(c.coldTokens ?? 0)} tokens read uncached`);
  }
  if (s.usageKnown && s.usage) lines.push(`Lifetime tokens: ${compact(s.usage.input)} in${s.usage.cached > 0 ? ` (${compact(s.usage.cached)} cached)` : ''} · ${compact(s.usage.output)} out`);
  lines.push(cost === null
    ? 'Cost: no estimate (usage or model pricing is not supported)'
    : `Cost: ≈ $${cost.toFixed(2)} at standard API rates, across compactions; not a subscription bill`);
  if (s.model) lines.push(`Model: ${s.model}`);
  if (now - s.modified > STALE_MS) lines.push('Transcript last changed over 5 minutes ago: the figures may be old');
  return lines.join('\n');
}

/** Context size against its limit, compactions, cache and cost; the tooltip explains them. */
export default function SessionMetrics({ hosted, data }: { hosted: Hosted; data: Record<string, Session> }) {
  // No session access or no indexed conversation yet: nothing to show
  const s = indexedSession(hosted, data);
  if (!s) return null;
  const c = s.context;
  const known = !!c && c.now > 0;
  const limit = known ? contextWindow(s) : null;
  const pct = known && limit ? Math.round(100 * c.now / limit.size) : null;
  const cost = estimatedCost(s);
  const now = Date.now();
  const cache = hosted.exit ? null : cacheState(s, now);
  if (!known && cost === null && !c?.compactions && !cache) return null;
  return <span className="hs-metrics" aria-label="Session metrics" title={metricsTooltip(s, cost, now)}>
    {known && <span className={`hs-metric-context${pct !== null && pct >= 80 ? ' high' : ''}`}>
      {pct !== null && <span className="hs-metric-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, pct)}%` }}/></span>}
      {pct !== null && <b>{limit?.assumed ? '~' : ''}{pct}%</b>}
      {compact(c.now)}
    </span>}
    {!!c?.compactions && <span>↻ {c.compactions}</span>}
    {cache && (cache.warm
      ? <span className="hs-metric-cache"><Flame size={10} aria-label="cache warm for"/>{runningFor(now, cache.until)}</span>
      : <span className="hs-metric-cache cold">cold</span>)}
    {cost !== null && <span>${cost.toFixed(2)}</span>}
  </span>;
}
