import { Terminal } from 'lucide-react';

/**
 * Which agent runs in a session, as a small mark. These are simplified marks
 * in each product's colour, not the vendors' official artwork.
 */
export default function AgentMark({ profile, size = 14 }: { profile: string; size?: number }) {
  if (profile === 'claude') {
    return <svg className="hs-mark claude" width={size} height={size} viewBox="0 0 16 16" role="img" aria-label="Claude Code">
      <g stroke="#d97757" strokeWidth="1.7" strokeLinecap="round">
        {[0, 30, 60, 90, 120, 150].map(angle => <line key={angle} x1="8" y1="1.4" x2="8" y2="14.6" transform={`rotate(${angle} 8 8)`}/>)}
      </g>
    </svg>;
  }
  if (profile === 'codex') {
    return <svg className="hs-mark codex" width={size} height={size} viewBox="0 0 16 16" role="img" aria-label="Codex" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round">
      <path d="M8 1.3 13.8 4.65v6.7L8 14.7 2.2 11.35v-6.7Z"/>
      <path d="m6.1 6.3-1.9 1.7 1.9 1.7M8.6 9.9h3"/>
    </svg>;
  }
  if (profile === 'antigravity') {
    return <svg className="hs-mark antigravity" width={size} height={size} viewBox="0 0 16 16" role="img" aria-label="Antigravity" fill="none" stroke="#60a5fa" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round">
      <path d="M8 1.8 13.4 13.5 8 10.6 2.6 13.5Z"/>
    </svg>;
  }
  return <Terminal className="hs-mark" size={size} aria-label="Shell"/>;
}
