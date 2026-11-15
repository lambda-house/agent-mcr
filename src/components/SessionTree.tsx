import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Bot } from 'lucide-react';
import AgentMark from './AgentMark';
import { compact, origin, sessionKey, sessionTree, totalTokens, type Session, type SessionNode } from '../utils/sessions';
import { formatAge } from '../utils/agent';
export default function SessionTree({ all, matches, selected, select }: { all: Session[]; matches: Session[]; selected: string; select: (key: string) => void }) {
  const nodes=useMemo(() => sessionTree(all,matches),[all,matches]);
  const [collapsed,setCollapsed]=useState<Set<string>>(new Set());
  const render=(node: SessionNode,depth=0): JSX.Element => {
    const s=node.session; const key=sessionKey(s);const closed=collapsed.has(key);
    return <div className={`sc-tree-node ${node.contextOnly ? 'context-only' : ''}`} key={key}>
      <div className="sc-tree-row" style={{paddingLeft:Math.min(depth,8)*16}}>
        <button className="sc-tree-toggle" aria-label={`${closed ? 'Expand' : 'Collapse'} ${s.name || s.id}`} aria-expanded={!closed} disabled={!node.children.length} onClick={() => setCollapsed(old => {const next=new Set(old);if(next.has(key))next.delete(key);else next.add(key);return next;})}>{node.children.length ? (closed ? <ChevronRight size={14}/> : <ChevronDown size={14}/>) : <span/>}</button>
        <button className={`sc-session ${selected === key ? 'selected' : ''}`} onClick={() => select(key)}>
          <strong title={`${s.title || s.name || s.id}\n${s.cwd}\n${s.model || 'Model unreported'}`}><AgentMark profile={s.provider} size={12}/> {s.title || s.name || s.id}</strong>
          <small className="ss-meta">{origin(s) !== 'human' && <span className={`sc-origin ${origin(s)}`}><Bot size={10}/> {origin(s)} · </span>}{formatAge(s.modified)} · {s.usageKnown ? `${compact(totalTokens(s.usage))} tokens` : 'usage unknown'}{s.status === 'working' || s.status === 'interrupted' ? <span className={`sc-status ${s.status}`} title="Activity inferred from the transcript"> · {s.status}</span> : null}</small>
          {node.contextOnly && <small className="sc-agent-name">Parent shown for context · excluded from totals</small>}
          {node.missingParent && <small className="sc-agent-name">Parent not indexed: {s.parentId}</small>}
        </button>
      </div>
      {!closed && node.children.map(child => render(child,depth+1))}
    </div>;
  };
  return <div className="sc-session-tree">{nodes.map(n => render(n))}</div>;
}
