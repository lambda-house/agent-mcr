import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { EarlierRow, HostedRow, rowIdle } from './SessionRow';
import { compact, formatSessionTitle, origin, sessionKey, sessionTree, totalTokens, type Session, type SessionNode } from '../utils/sessions';
import { liveSessionLabel, type Hosted } from '../utils/harness';

/** What the row itself no longer says: the main list keeps such detail in the tooltip too. */
function about(node: SessionNode, title: string): string {
  const s = node.session;
  return [
    title, s.cwd, s.model || 'Model unreported',
    `${origin(s) === 'human' ? 'Human session' : origin(s)} · ${s.usageKnown ? `${compact(totalTokens(s.usage))} tokens` : 'usage unknown'}`,
    s.status === 'working' || s.status === 'interrupted' ? `${s.status} (inferred from the transcript)` : '',
    node.contextOnly ? 'Parent shown for context · excluded from totals' : '',
    node.missingParent ? `Parent not indexed: ${s.parentId}` : '',
  ].filter(Boolean).join('\n');
}

/**
 * Sessions as a tree (subagents under their parents). A row is the row of the
 * Live list: the live one for a conversation that runs now (`live`, by
 * conversation key), the earlier one otherwise.
 */
export default function SessionTree({ all, matches, selected, select, live }: { all: Session[]; matches: Session[]; selected: string; select: (key: string) => void; live?: Map<string, Hosted> }) {
  const nodes=useMemo(() => sessionTree(all,matches),[all,matches]);
  const [collapsed,setCollapsed]=useState<Set<string>>(new Set());
  const render=(node: SessionNode,depth=0): React.JSX.Element => {
    const s=node.session; const key=sessionKey(s);const closed=collapsed.has(key);
    const hosted=live?.get(key);
    const own=s.parentId ? s.title || s.name || s.id : formatSessionTitle(s);
    const title=hosted ? liveSessionLabel(hosted,{[s.id]:own}) : own;
    return <div className={`sc-tree-node ${node.contextOnly ? 'context-only' : ''}`} key={key}>
      <div className="sc-tree-row" style={{paddingLeft:Math.min(depth,8)*16}}>
        <button className="sc-tree-toggle" aria-label={`${closed ? 'Expand' : 'Collapse'} ${title}`} aria-expanded={!closed} disabled={!node.children.length} onClick={() => setCollapsed(old => {const next=new Set(old);if(next.has(key))next.delete(key);else next.add(key);return next;})}>{node.children.length ? (closed ? <ChevronRight size={14}/> : <ChevronDown size={14}/>) : <span/>}</button>
        <button className={`sc-session hs-item ${hosted ? (rowIdle(hosted) ? 'idle' : '') : 'hs-resume'} ${selected === key ? 'selected' : ''}`} title={about(node,title)} onClick={() => select(key)}>
          {hosted ? <HostedRow hosted={hosted} label={title} session={s}/> : <EarlierRow agent={s.provider} title={title} modified={s.modified}/>}
        </button>
      </div>
      {!closed && node.children.map(child => render(child,depth+1))}
    </div>;
  };
  return <div className="sc-session-tree">{nodes.map(n => render(n))}</div>;
}
