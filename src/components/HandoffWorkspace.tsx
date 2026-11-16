import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, ChevronDown, ChevronRight, GripVertical, RefreshCw, RotateCcw } from 'lucide-react';
import AgentMark from './AgentMark';
import { harnessApi, hostedLabel, hostedState, isSupervisor, type Hosted } from '../utils/harness';
import { isTauri } from '../utils/tauri';
import '../styles/handoff.css';

interface HandoffAgent {
  id: string;
  name: string;
  profile: string;
  model: string;
  cost: string;
  status: 'idle' | 'working' | 'waiting';
  description: string;
  slotLabel: string;
  slotDetail?: string;
}

interface HandoffItem {
  id: string;
  label: string;
  kind: 'file' | 'source' | 'fact' | 'decision' | 'note';
  lost?: boolean;
  why?: string;
}

interface HandoffCard {
  id: string;
  from: string;
  to: string;
  title: string;
  items: HandoffItem[];
}

const DEMO_AGENTS: HandoffAgent[] = [
  {
    id: 'researcher',
    name: 'Researcher',
    profile: 'claude',
    model: 'Opus 4.5',
    cost: '$1.33',
    status: 'idle',
    description: 'Finds the sources, pulls the facts and decides the angle.',
    slotLabel: 'Up next',
    slotDetail: 'Changelog v2 · +2',
  },
  {
    id: 'writer',
    name: 'Writer',
    profile: 'codex',
    model: 'GPT-5',
    cost: '$0.62',
    status: 'working',
    description: "Turns the brief into a first draft in the team's voice.",
    slotLabel: 'Reply to churned team',
    slotDetail: 'Drafting',
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    profile: 'antigravity',
    model: 'Gemini Pro',
    cost: '$0.30',
    status: 'idle',
    description: 'Checks every claim against its source before it ships.',
    slotLabel: 'Ready for a task',
  },
];

const INITIAL_DEMO_HANDOFFS: HandoffCard[] = [
  {
    id: 'h1',
    from: 'researcher',
    to: 'writer',
    title: 'Reply to churned team',
    items: [
      { id: 'i1', label: 'reply-brief.md', kind: 'file' },
      { id: 'i2', label: '12 customer threads', kind: 'source' },
      { id: 'i3', label: 'Lead with fallback pricing', kind: 'decision' },
      { id: 'i4', label: 'Q3 SLA exception note', kind: 'note', lost: true, why: 'Truncated when context window compacted' },
      { id: 'i5', label: 'Migration timeline (14d)', kind: 'fact', lost: true, why: 'Omitted from handoff summary' },
    ],
  },
  {
    id: 'h2',
    from: 'researcher',
    to: 'writer',
    title: 'Launch post v2',
    items: [
      { id: 'i6', label: 'launch-brief.md', kind: 'file' },
      { id: 'i7', label: 'Benchmark numbers', kind: 'fact' },
    ],
  },
  {
    id: 'h3',
    from: 'writer',
    to: 'reviewer',
    title: 'Support macro for refunds',
    items: [
      { id: 'i8', label: 'Macro draft', kind: 'file' },
      { id: 'i9', label: 'Tone: warm, concise', kind: 'note' },
      { id: 'i10', label: 'EU 14-day statutory clause', kind: 'fact', lost: true, why: 'Not linked to policy source' },
    ],
  },
  {
    id: 'h4',
    from: 'writer',
    to: 'reviewer',
    title: 'Onboarding checklist',
    items: [
      { id: 'i11', label: 'checklist.mdx', kind: 'file' },
      { id: 'i12', label: 'Screenshots verified', kind: 'decision' },
    ],
  },
];

export default function HandoffWorkspace({ active }: { active: boolean }) {
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [hosted, setHosted] = useState<Hosted[]>([]);
  const [handoffs, setHandoffs] = useState<HandoffCard[]>(INITIAL_DEMO_HANDOFFS);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overAgent, setOverAgent] = useState<string | null>(null);
  const [pulseKey, setPulseKey] = useState(0);

  useEffect(() => {
    if (!active || !isTauri()) return;
    let stop = false;
    const load = () => { harnessApi.list().then(list => { if (!stop) setHosted(list.filter(h => !h.exit && !isSupervisor(h))); }).catch(() => {}); };
    load();
    const t = setInterval(load, 3000);
    return () => { stop = true; clearInterval(t); };
  }, [active]);

  const liveAgents: HandoffAgent[] = useMemo(() => {
    return hosted.slice(0, 4).map(h => {
      const st = hostedState(h);
      const profile = h.harness?.profile || h.meta.profile || 'claude';
      return {
        id: h.id,
        name: hostedLabel(h),
        profile,
        model: profile === 'claude' ? 'Claude Code' : profile === 'codex' ? 'Codex' : profile,
        cost: `${h.openTasks ?? 0} tasks`,
        status: st === 'waiting' ? 'waiting' : st === 'working' ? 'working' : 'idle',
        description: h.cwd,
        slotLabel: h.harness?.status || (st === 'working' ? 'Running turn' : 'Ready for handoff'),
      };
    });
  }, [hosted]);

  const liveHandoffs: HandoffCard[] = useMemo(() => {
    if (liveAgents.length < 2) return [];
    const cards: HandoffCard[] = [];
    for (let i = 0; i < liveAgents.length - 1; i++) {
      const a = liveAgents[i];
      const b = liveAgents[i + 1];
      const src = hosted.find(h => h.id === a.id);
      const linked = src?.peers?.includes(b.id);
      cards.push({
        id: `live-${a.id}-${b.id}`,
        from: a.id,
        to: b.id,
        title: linked ? 'Peer message exchange' : 'Ready to relay context',
        items: [
          { id: `li-${a.id}-1`, label: `${a.name} workspace`, kind: 'file' },
          ...(linked ? [{ id: `li-${a.id}-2`, label: 'Direct mcr peer link', kind: 'source' as const }] : [{ id: `li-${a.id}-3`, label: 'Context not yet sent to peer', kind: 'note' as const, lost: true, why: 'No mcr send_message recorded yet' }]),
        ],
      });
    }
    return cards;
  }, [liveAgents, hosted]);

  const agents = mode === 'live' ? liveAgents : DEMO_AGENTS;
  const activeHandoffs = mode === 'live' ? liveHandoffs : handoffs;
  const draggingCard = activeHandoffs.find(c => c.id === draggingId) ?? null;
  const draggingFromIdx = draggingCard ? agents.findIndex(a => a.id === draggingCard.from) : -1;

  const restoreItem = (handoffId: string, itemId: string) => {
    if (mode !== 'demo') return;
    setHandoffs(prev => prev.map(h => h.id !== handoffId ? h : {
      ...h,
      items: h.items.map(it => it.id === itemId ? { ...it, lost: false, why: undefined } : it),
    }));
  };

  const forwardCard = (cardId: string, targetAgentId: string) => {
    if (mode !== 'demo') return;
    const targetIdx = agents.findIndex(a => a.id === targetAgentId);
    if (targetIdx <= 0) return;
    const prevAgent = agents[targetIdx - 1];
    setHandoffs(prev => prev.map(c => c.id !== cardId ? c : { ...c, from: prevAgent.id, to: targetAgentId }));
  };

  return (
    <div className="ho-wrap">
      <div className="ho-toolbar">
        <div className="ho-title-group">
          <h2>Agent Handoff</h2>
          <p>Relay pipeline: what context moved to the next agent, what got lost, and quick recovery.</p>
        </div>
        <div className="ho-controls">
          <div className="ho-seg" role="group" aria-label="Handoff data source">
            <button type="button" aria-pressed={mode === 'demo'} onClick={() => setMode('demo')}>Relay demo</button>
            <button type="button" aria-pressed={mode === 'live'} onClick={() => setMode('live')}>Live sessions ({liveAgents.length})</button>
          </div>
          <button type="button" className="ho-replay-btn" onClick={() => setPulseKey(k => k + 1)}>
            <RefreshCw size={13}/> Replay flow
          </button>
        </div>
      </div>

      {mode === 'live' && liveAgents.length < 2 ? (
        <div className="ho-board">
          <p className="ho-empty-lane">Start at least 2 live agent sessions in the Live tab to inspect live relay handoffs, or switch to Relay demo.</p>
        </div>
      ) : (
        <div className="ho-board" style={{ ['--ho-cols' as string]: agents.length, ['--ho-lanes' as string]: Math.max(1, agents.length - 1) }}>
          <div className="ho-agents">
            {agents.map((a, idx) => {
              const canDrop = !!draggingCard && idx > draggingFromIdx;
              const isDimmed = !!draggingCard && idx <= draggingFromIdx;
              return (
                <div
                  key={a.id}
                  className={`ho-agent${canDrop && overAgent === a.id ? ' is-target' : ''}${isDimmed ? ' is-dimmed' : ''}`}
                  onDragOver={e => { if (canDrop) { e.preventDefault(); setOverAgent(a.id); } }}
                  onDragLeave={() => { if (overAgent === a.id) setOverAgent(null); }}
                  onDrop={e => {
                    e.preventDefault();
                    if (canDrop && draggingCard) forwardCard(draggingCard.id, a.id);
                    setDraggingId(null);
                    setOverAgent(null);
                  }}
                >
                  <div className="ho-agent-head">
                    <div className="ho-agent-id">
                      <span className="ho-agent-avatar"><AgentMark profile={a.profile} size={15}/></span>
                      <span className="ho-agent-name">
                        <strong>{a.name}</strong>
                        <small>{a.model}</small>
                      </span>
                    </div>
                    <div className="ho-agent-meta">
                      <span className="ho-cost">{a.cost}</span>
                      <span className={`ho-status-pill ${a.status}`}>
                        <span className={`hs-dot ${a.status}`}/>
                        {a.status === 'working' ? 'Working' : a.status === 'waiting' ? 'Waiting' : 'Idle'}
                      </span>
                    </div>
                  </div>
                  <p className="ho-agent-desc">{a.description}</p>
                  <div className="ho-agent-slot">
                    <span>{a.slotLabel}</span>
                    {a.slotDetail && <strong>{a.slotDetail}</strong>}
                  </div>
                  <span className="ho-port" aria-hidden="true"/>
                </div>
              );
            })}
          </div>

          <svg key={pulseKey} className="ho-wires" viewBox="0 0 900 48" preserveAspectRatio="none" aria-hidden="true">
            {agents.slice(0, -1).map((_, i) => {
              const cols = agents.length;
              const x1 = ((i + 0.5) / cols) * 900;
              const x2 = ((i + 1.5) / cols) * 900;
              const mid = (x1 + x2) / 2;
              const r = 8;
              const y = 22;
              const d = `M ${x1} 0 V ${y - r} Q ${x1} ${y}, ${x1 + r} ${y} H ${mid - r} Q ${mid} ${y}, ${mid} ${y + r} V 48 M ${x2} 0 V ${y - r} Q ${x2} ${y}, ${x2 - r} ${y} H ${mid + r} Q ${mid} ${y}, ${mid} ${y + r} V 48`;
              return (
                <g key={i}>
                  <path className="ho-wire-base" d={d}/>
                  <path className="ho-wire-pulse" d={d}/>
                </g>
              );
            })}
          </svg>

          <div className="ho-lanes">
            {agents.slice(0, -1).map((fromAgent, idx) => {
              const toAgent = agents[idx + 1];
              const laneCards = activeHandoffs.filter(c => c.from === fromAgent.id && c.to === toAgent.id);
              const nextTarget = agents[idx + 2];
              return (
                <div key={`${fromAgent.id}-${toAgent.id}`} className="ho-lane">
                  <div className="ho-lane-head">
                    <span className="ho-lane-route">
                      <AgentMark profile={fromAgent.profile} size={12}/>
                      <span>{fromAgent.name}</span>
                      <ArrowRight size={12}/>
                      <AgentMark profile={toAgent.profile} size={12}/>
                      <span>{toAgent.name}</span>
                    </span>
                    <span className="ho-lane-count">{laneCards.length}</span>
                  </div>

                  <div className="ho-cards">
                    {laneCards.map(card => {
                      const isOpen = !!expanded[card.id];
                      const lostItems = card.items.filter(it => it.lost);
                      const carriedSummary = card.items.filter(it => !it.lost).map(it => it.label).join(', ');
                      return (
                        <div
                          key={card.id}
                          className={`ho-card${isOpen ? ' expanded' : ''}`}
                          draggable={mode === 'demo'}
                          onDragStart={() => setDraggingId(card.id)}
                          onDragEnd={() => { setDraggingId(null); setOverAgent(null); }}
                        >
                          <button type="button" className="ho-card-top" aria-expanded={isOpen} onClick={() => setExpanded(e => ({ ...e, [card.id]: !isOpen }))}>
                            <span className="ho-card-title">{card.title}</span>
                            {isOpen ? <ChevronDown size={13}/> : <ChevronRight size={13}/>}
                          </button>
                          <div className="ho-card-summary" title={carriedSummary}>{carriedSummary || 'No carried items'}</div>
                          <div className="ho-card-foot">
                            {lostItems.length > 0 ? (
                              <span className="ho-pill-warn">
                                <AlertTriangle size={11}/> {lostItems.length} context lost
                              </span>
                            ) : (
                              <span className="ho-pill-ok">
                                <CheckCircle2 size={11}/> Looks good
                              </span>
                            )}
                            {mode === 'demo' && nextTarget && (
                              <button type="button" className="ho-forward-btn" title={`Assign to ${nextTarget.name}`} onClick={() => forwardCard(card.id, nextTarget.id)}>
                                <GripVertical size={10}/> → {nextTarget.name}
                              </button>
                            )}
                          </div>

                          {isOpen && (
                            <div className="ho-items">
                              {card.items.map(it => (
                                <div key={it.id} className={`ho-item${it.lost ? ' lost' : ''}`}>
                                  <div className="ho-item-main">
                                    <span className="ho-item-label">
                                      <span>{it.label}</span>
                                      <span className="ho-item-kind">{it.kind}</span>
                                    </span>
                                    {it.lost && it.why && <span className="ho-item-why">{it.why}</span>}
                                  </div>
                                  {it.lost && mode === 'demo' && (
                                    <button type="button" className="ho-restore-btn" onClick={() => restoreItem(card.id, it.id)}>
                                      <RotateCcw size={10}/> Add back
                                    </button>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {laneCards.length === 0 && <p className="ho-empty-lane">No handoffs in this lane.</p>}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
