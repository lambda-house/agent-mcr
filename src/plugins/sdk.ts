import type React from 'react';
import { PluginRegistry, type PluginApi as WorkbenchPluginApi } from '@lambda-house/workbench';
import type { LayoutPreset, PaneItem, PaneNode } from '../utils/paneLayout';
import type { HarnessStatus, Hosted, Resumable } from '../utils/harness';
import type { Session } from '../utils/sessions';

export type PluginEventMap = {
  'session:selected': { id: string };
  'session:started': { id: string; profile: string; cwd: string };
  'session:closed': { id: string };
  'pane:split': { leafId: string; dir: 'row' | 'col' };
  'pane:closed': { leafId: string };
  'doc:opened': { path: string };
  'doc:saved': { path: string };
  'command-panel:open': Record<string, never>;
};

export type PluginEventName = keyof PluginEventMap;

export interface TopTabContext {
  active: boolean;
}

export interface TopTabPlugin {
  id: string;
  label: string;
  title?: string;
  order?: number;
  icon: React.ReactNode;
  render: (ctx: TopTabContext) => React.ReactNode;
}

export interface LiveSidebarState {
  status: HarnessStatus | null;
  resumable: Resumable[];
  titles: Record<string, string>;
  starting: boolean;
  error: string;
  copied: boolean;
  setCopied: (v: boolean) => void;
  setError: (msg: string) => void;
  setStatus: React.Dispatch<React.SetStateAction<HarnessStatus | null>>;
  selectSession: (id: string) => void;
  openSupervisor: () => void;
  startSession: (profile?: string, cwd?: string, resumeId?: string) => Promise<void>;
  renderSessionRow: (h: Hosted) => React.ReactNode;
  openNewAgentInDir: (dir: string) => void;
  renderSupervisorMenu: (supervisor: Hosted) => React.ReactNode;
}

export interface LiveControllerContext {
  active: boolean;
  hosted: Hosted[];
  opened: string[];
  selected: string;
  layout: PaneNode;
  focusedPane: string;
  setFocusedPane: (leafId: string) => void;
  openItem: (item: PaneItem) => void;
  assignPaneItem: (leafId: string, item: PaneItem) => void;
  clearItemFromLayout: (predicate: (item: PaneItem) => boolean) => void;
  splitPane: (leafId: string, dir: 'row' | 'col') => void;
  closePane: (leafId: string) => void;
  applyPreset: (preset: LayoutPreset) => void;
  openNewAgent: (targetLeafId?: string) => void;
  reportError: (msg: string) => void;
  sidebarState?: LiveSidebarState;
}

export interface PaneRenderContext {
  leafId: string;
  item: PaneItem;
  multiPane: boolean;
  isFocused: boolean;
  controller: LiveControllerContext;
}

export interface PaneTypePlugin {
  kind: string;
  label: string;
  renderTitle: (ctx: PaneRenderContext) => React.ReactNode;
  renderBody: (ctx: PaneRenderContext) => React.ReactNode;
}

export interface SidebarSectionPlugin {
  id: string;
  order?: number;
  render: (ctx: LiveControllerContext) => React.ReactNode;
}

export interface EmptyActionContext {
  leafId: string;
  controller: LiveControllerContext;
}

export interface EmptyActionPlugin {
  id: string;
  title: string;
  subtitle: string;
  order?: number;
  icon: React.ReactNode;
  onClick: (ctx: EmptyActionContext) => void;
}

export interface SessionBadge {
  label: string;
  tone?: 'accent' | 'muted' | 'warn';
}

export interface SessionEnricher {
  id: string;
  enrichResumable?: (r: Resumable) => { role?: string; tags?: string[]; badges?: SessionBadge[] } | null;
}

export type OverrideSlot =
  | 'live:empty-pane'
  | 'live:sidebar'
  | 'live:new-agent'
  | 'live:layout-bar'
  | 'live:pane-tools'
  | 'live:session-header';

export interface ComponentOverrideMap {
  'live:empty-pane': (ctx: EmptyActionContext & { defaultRender: () => React.ReactNode }) => React.ReactNode;
  'live:sidebar': (ctx: { controller: LiveControllerContext; defaultRender: () => React.ReactNode }) => React.ReactNode;
  'live:new-agent': (ctx: { open: boolean; onClose: () => void; controller: LiveControllerContext; defaultRender: () => React.ReactNode }) => React.ReactNode;
  'live:layout-bar': (ctx: { leavesCount: number; controller: LiveControllerContext; defaultRender: () => React.ReactNode }) => React.ReactNode;
  /** Buttons in a pane's title bar (split, close); the core shows none */
  'live:pane-tools': (ctx: { leafId: string; multiPane: boolean; controller: LiveControllerContext }) => React.ReactNode;
  'live:session-header': (ctx: {
    session: Hosted;
    leafId: string;
    multiPane: boolean;
    isFocused: boolean;
    statsOpen: boolean;
    toggleStats: () => void;
    controller: LiveControllerContext;
    defaultRender: () => React.ReactNode;
  }) => React.ReactNode;
}

export interface AppWrapperPlugin {
  id: string;
  order?: number;
  wrap: (children: React.ReactNode) => React.ReactNode;
}

export interface GlobalOverlayContext {
  enabled: boolean | null;
  sessions: Session[];
  directory: string;
  onClearDirectory: () => void;
  onSelectSession: (key: string) => void;
  /** Show a hosted session in Live */
  onOpenLive?: (hostedId: string) => void;
  onNavigateView: (viewId: string) => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
  onEnableAccess: () => void;
  topTabs: TopTabPlugin[];
}

export interface GlobalOverlayPlugin {
  id: string;
  order?: number;
  render: (ctx: GlobalOverlayContext) => React.ReactNode;
}

export interface SettingsTabPlugin {
  id: string;
  label: string;
  group?: string;
  order?: number;
  icon?: React.ReactNode;
  render: () => React.ReactNode;
}

export interface PluginApi {
  registerTopTab: (tab: TopTabPlugin) => void;
  registerPaneType: (pane: PaneTypePlugin) => void;
  registerSidebarSection: (section: SidebarSectionPlugin) => void;
  registerEmptyAction: (action: EmptyActionPlugin) => void;
  registerSessionEnricher: (enricher: SessionEnricher) => void;
  registerAppWrapper: (wrapper: AppWrapperPlugin) => void;
  registerGlobalOverlay: (overlay: GlobalOverlayPlugin) => void;
  registerSettingsTab: (tab: SettingsTabPlugin) => void;
  overrideComponent: <K extends OverrideSlot>(slot: K, render: ComponentOverrideMap[K]) => void;
  onEvent: <E extends PluginEventName>(event: E, handler: (payload: PluginEventMap[E]) => void) => () => void;
  emitEvent: <E extends PluginEventName>(event: E, payload: PluginEventMap[E]) => void;
}

export interface McrPlugin {
  id: string;
  name: string;
  version?: string;
  description?: string;
  defaultDisabled?: boolean;
  setup: (api: PluginApi) => void | (() => void);
}

// Agent MCR's extension points, slots and events in the workbench's plugin
// registry (@lambda-house/workbench), declared by merging. Its plugins keep
// the typed API above; the registry does the rest (shared UI spec §5.7).
interface McrPoints {
  'sessions:top-tab': TopTabPlugin;
  'sessions:overlay': GlobalOverlayPlugin;
  'live:pane-type': PaneTypePlugin;
  'live:sidebar-section': SidebarSectionPlugin;
  'live:empty-action': EmptyActionPlugin;
  'live:session-enricher': SessionEnricher;
  'app:wrapper': AppWrapperPlugin;
  'settings:tab': SettingsTabPlugin;
}

declare module '@lambda-house/workbench' {
  interface WorkbenchPoints extends McrPoints {}
  interface WorkbenchSlots extends ComponentOverrideMap {}
  interface WorkbenchEvents extends PluginEventMap {}
}

/** Agent MCR's plugin API on the workbench's: each register* contributes to its point. */
function mcrApi(api: WorkbenchPluginApi): PluginApi {
  return {
    registerTopTab: tab => api.contribute('sessions:top-tab', tab),
    registerPaneType: pane => api.contribute('live:pane-type', pane),
    registerSidebarSection: section => api.contribute('live:sidebar-section', section),
    registerEmptyAction: action => api.contribute('live:empty-action', action),
    registerSessionEnricher: enricher => api.contribute('live:session-enricher', enricher),
    registerAppWrapper: wrapper => api.contribute('app:wrapper', wrapper),
    registerGlobalOverlay: overlay => api.contribute('sessions:overlay', overlay),
    registerSettingsTab: tab => api.contribute('settings:tab', tab),
    overrideComponent: (slot, render) => api.overrideSlot(slot, render),
    onEvent: (event, handler) => api.onEvent(event, handler),
    emitEvent: (event, payload) => api.emitEvent(event, payload),
  };
}

/** The registry under the names Agent MCR's code reads it by. Which plugins are off stays under agent-mcr:* in localStorage. */
class McrPluginRegistry {
  readonly workbench = new PluginRegistry(typeof localStorage === 'undefined' ? null : localStorage, 'agent-mcr');

  subscribe = (fn: () => void): (() => void) => this.workbench.subscribe(fn);

  register(plugin: McrPlugin): void {
    this.workbench.register({ ...plugin, setup: api => plugin.setup(mcrApi(api)) });
  }

  unregister(pluginId: string): void { this.workbench.unregister(pluginId); }
  isEnabled(pluginId: string): boolean { return this.workbench.isEnabled(pluginId); }
  setEnabled(pluginId: string, enabled: boolean): void { this.workbench.setEnabled(pluginId, enabled); }
  listPlugins(): Array<Omit<McrPlugin, 'setup'> & { enabled: boolean }> { return this.workbench.listPlugins().map(({ setup: _setup, ...plugin }) => plugin); }

  getTopTabs(): TopTabPlugin[] { return this.workbench.items('sessions:top-tab'); }
  /** The last plugin to register a kind has it. */
  getPaneType(kind: string): PaneTypePlugin | undefined { return this.workbench.items('live:pane-type').filter(p => p.kind === kind).pop(); }
  getSidebarSections(): SidebarSectionPlugin[] { return this.workbench.items('live:sidebar-section'); }
  getEmptyActions(): EmptyActionPlugin[] { return this.workbench.items('live:empty-action'); }
  getSessionEnrichers(): SessionEnricher[] { return this.workbench.items('live:session-enricher'); }
  getAppWrappers(): AppWrapperPlugin[] { return this.workbench.items('app:wrapper'); }
  getGlobalOverlays(): GlobalOverlayPlugin[] { return this.workbench.items('sessions:overlay'); }
  getSettingsTabs(): SettingsTabPlugin[] { return this.workbench.items('settings:tab'); }
  getOverride<K extends OverrideSlot>(slot: K): ComponentOverrideMap[K] | undefined { return this.workbench.slot(slot); }

  onEvent<E extends PluginEventName>(event: E, handler: (payload: PluginEventMap[E]) => void): () => void { return this.workbench.onEvent(event, handler); }
  emitEvent<E extends PluginEventName>(event: E, payload: PluginEventMap[E]): void { this.workbench.emitEvent(event, payload); }
}

export const pluginRegistry = new McrPluginRegistry();

export function createPlugin(plugin: McrPlugin): McrPlugin {
  return plugin;
}
