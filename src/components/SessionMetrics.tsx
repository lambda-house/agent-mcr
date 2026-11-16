import { useEffect, useState } from 'react';
import { compact, sessionApi, sessionKey, type Session } from '../utils/sessions';
import type { Hosted } from '../utils/harness';
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

export default function SessionMetrics({ hosted, data }: { hosted: Hosted; data: Record<string, Session> }) {
  const provider = hosted.harness?.profile || hosted.meta.profile;
  if (provider !== 'claude' && provider !== 'codex') return null;
  const s = data[`${provider}:${hosted.harness?.agentSession || ''}`];
  const c = s?.context;
  const known = !!c && c.now > 0;
  const pct = known && c.window > 0 ? Math.round(100 * c.now / c.window) : null;
  const cost = s ? estimatedCost(s) : null;
  const old = !!s && Date.now() - s.modified > 5 * 60_000;
  const unavailable = 'Telemetry unavailable. Requires session access and an indexed conversation.';
  return <span className="hs-metrics" aria-label="Session metrics">
    <span className={`hs-metric-context${pct !== null && pct >= 80 ? ' high' : ''}`} title={known ? `Latest recorded model input: ${compact(c.now)} tokens${c.window ? ` / ${compact(c.window)}` : '; context limit unreported'}. Not lifetime usage.${old ? ' Transcript last changed over 5 minutes ago.' : ''}` : unavailable}>
      {pct !== null && <span className="hs-metric-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, pct)}%` }}/></span>}
      Context {pct !== null ? `${pct}%` : known ? `${compact(c.now)} tok` : '—'}{old ? ' · old' : ''}
    </span>
    <span title={cost === null ? 'Cost unavailable: usage or model pricing is not supported.' : 'Estimated lifetime model cost in USD at standard API rates, across compactions. Assumes 5-minute cache writes; excludes service-tier, long-context and regional modifiers. Not a subscription bill.'}>{cost === null ? 'Cost —' : `≈ $${cost.toFixed(2)}`}</span>
    <span title={c ? 'Compaction events observed in the indexed transcript; missing or copied history can affect counts.' : unavailable}>↻ {c ? `${c.compactions} comp.` : '— comp.'}</span>
  </span>;
}
