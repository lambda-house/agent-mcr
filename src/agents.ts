import { createAgents, type AgentHost } from '@lambda-house/agents';
import { disableAgentWorkspace, enableAgentWorkspace, getAgentWorkspace, isTauri, markRead, onAgentFilesChanged, readSnapshot } from './utils/tauri';
import { documentWindowPath } from './utils/documentWindow';

// Agent MCR's agent documents (@lambda-house/agents): the backend's agent
// workspace (src-tauri/src/agent.rs): the agents' own folders under ~/.claude,
// ~/.codex and ~/.gemini, and the folders sessions work in, by session folder.
// The list is the `agent-docs` pane of Documents (documents.tsx: AgentPane).

// The Tauri functions are looked up when called, not when this module loads
// (tests replace that module with only what they use).
export const agentHost: AgentHost = {
  // A memory reader window shows its one document: no list, no scans
  get available() { return isTauri() && !documentWindowPath; },
  workspace: () => getAgentWorkspace(),
  onChange: (handler) => onAgentFilesChanged(handler),
  enable: () => enableAgentWorkspace(),
  disable: () => disableAgentWorkspace(),
  markRead: (paths) => markRead(paths),
  readSnapshot: (path) => readSnapshot(path),
};

export const agents = createAgents(agentHost);
