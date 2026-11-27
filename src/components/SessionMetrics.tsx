import { useEffect, useRef, useState } from 'react';
import { Flame } from 'lucide-react';
import { cacheState, compact, contextWindow, sessionApi, sessionKey, type Session } from '../utils/sessions';
import { runningFor, type Hosted } from '../utils/harness';
import { estimatedCost } from '../utils/sessionCost';
import { keepSame } from '@lambda-house/ui';

/** The index keys of the listed Claude and Codex conversations, running or ended, in one order */
export function hostedKeys(hosted: Hosted[]): string[] {
  const keys = new Set<string>();
  for (const h of hosted) {
    const provider = h.harness?.profile || h.meta.profile;
    const id = h.harness?.agentSession;
    // Ended rows too: they stay in the list with their figures until they are removed
    if (id && (provider === 'claude' || provider === 'codex')) keys.add(`${provider}:${id}`);
  }
  return [...keys].sort();
}

/**
 * One index refresh for the entire sidebar, never one scan per row. Only the
 * hosted conversations come back (MCR-139): the whole index, sent every ten
 * seconds, was megabytes the web view parsed and dropped each time.
 */
const NO_METRICS: Record<string, Session> = {};

export function useSessionMetrics(active: boolean, hosted: Hosted[], sessionAccess: boolean) {
  const [data, setData] = useState(NO_METRICS);
  const keys = hostedKeys(hosted).join(' ');
  const wanted = useRef(keys);
  wanted.current = keys;
  const loader = useRef<() => void>(() => {});
  useEffect(() => {
    if (!sessionAccess) { setData(NO_METRICS); return; }
    if (!active) return;
    let live = true, pending = false;
    const load = async () => {
      if (pending || document.hidden) return;
      pending = true;
      const requested = wanted.current;
      try {
        const asked = requested ? requested.split(' ') : [];
        const sessions = asked.length ? await sessionApi.pick(asked) : [];
        if (live) setData(held => {
          const next = Object.fromEntries(sessions.map(s => {
            const key = sessionKey(s);
            return [key, keepSame(held[key], s)];
          }));
          const entries = Object.entries(next);
          return entries.length === Object.keys(held).length && entries.every(([key, s]) => held[key] === s) ? held : next;
        });
      } catch { if (live) setData(NO_METRICS); }
      finally {
        pending = false;
        if (live && requested !== wanted.current) void load();
      }
    };
    loader.current = () => void load();
    void load();
    const timer = setInterval(() => void load(), 10_000);
    return () => { live = false; clearInterval(timer); loader.current = () => {}; };
  }, [active, sessionAccess]);
  // A session that started or ended is asked for at once, not at the next tick
  useEffect(() => { loader.current(); }, [keys]);
  return sessionAccess ? data : NO_METRICS;
}

const STALE_MS = 5 * 60_000;

/** The indexed conversation of a hosted session, when the Sessions index has it. */
export function indexedSession(hosted: Hosted, data: Record<string, Session>): Session | undefined {
  const provider = hosted.harness?.profile || hosted.meta.profile;
  if (provider !== 'claude' && provider !== 'codex') return undefined;
  return data[`${provider}:${hosted.harness?.agentSession || ''}`];
}

/** The row class of a live session by its prompt cache: glowing while warm, ashes once cold. */
export function cacheClass(hosted: Hosted, session: Session | undefined, now: number): string {
  const cache = !hosted.exit && session && cacheState(session, now);
  if (!cache) return '';
  // A session at work refreshes its cache with every request, whatever the index last saw
  if (cache.warm || hosted.harness?.state === 'working') return cache.cooling ? 'cache-warm cache-cooling' : 'cache-warm';
  // Past an assumed lifetime the cache may still be there: neither glow nor ashes
  return cache.assumed ? '' : 'cache-cold';
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
    if (cache.assumed) lines.push(cache.warm
      ? `Cache: probably warm for another ${runningFor(now, cache.until)}. Codex records no cache lifetime; a request within ${life} of the last one is usually still served from the cache`
      : `Cache: unknown. Codex records no cache lifetime, and the last request was over ${life} ago; after hours of pause the cache is often gone`);
    else lines.push(cache.warm
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
  return s ? <SessionFigures session={s} cache={!hosted.exit}/> : null;
}

/** The figures of one indexed conversation; `cache` is false for one that has ended. */
export function SessionFigures({ session: s, cache: withCache = true }: { session: Session; cache?: boolean }) {
  const c = s.context;
  const known = !!c && c.now > 0;
  const limit = known ? contextWindow(s) : null;
  const pct = known && limit ? Math.round(100 * c.now / limit.size) : null;
  const cost = estimatedCost(s);
  const now = Date.now();
  const cache = withCache ? cacheState(s, now) : null;
  if (!known && cost === null && !c?.compactions && !cache) return null;
  return <span className="hs-metrics" aria-label="Session metrics" title={metricsTooltip(s, cost, now)}>
    {known && <span className={`hs-metric-context${pct !== null && pct >= 80 ? ' high' : ''}`}>
      {pct !== null && <span className="hs-metric-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, pct)}%` }}/></span>}
      {pct !== null && <b>{limit?.assumed ? '~' : ''}{pct}%</b>}
      {compact(c.now)}
    </span>}
    {!!c?.compactions && <span>↻ {c.compactions}</span>}
    {cache && (cache.warm
      ? <span className="hs-metric-cache"><Flame size={10} aria-label={cache.assumed ? 'cache probably warm for' : 'cache warm for'}/>{cache.assumed ? '~' : ''}{runningFor(now, cache.until)}</span>
      : !cache.assumed && <span className="hs-metric-cache cold">cold</span>)}
    {cost !== null && <span>${cost.toFixed(2)}</span>}
  </span>;
}
