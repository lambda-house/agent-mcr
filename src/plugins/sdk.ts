import type React from 'react';
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
  | 'live:session-header';

export interface ComponentOverrideMap {
  'live:empty-pane': (ctx: EmptyActionContext & { defaultRender: () => React.ReactNode }) => React.ReactNode;
  'live:sidebar': (ctx: { controller: LiveControllerContext; defaultRender: () => React.ReactNode }) => React.ReactNode;
  'live:new-agent': (ctx: { open: boolean; onClose: () => void; controller: LiveControllerContext; defaultRender: () => React.ReactNode }) => React.ReactNode;
  'live:layout-bar': (ctx: { leavesCount: number; controller: LiveControllerContext; defaultRender: () => React.ReactNode }) => React.ReactNode;
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

interface RegisteredEntry {
  plugin: McrPlugin;
  cleanup: Array<() => void>;
}

const DISABLED_KEY = 'agent-mcr:disabled-plugins';
const ENABLED_KEY = 'agent-mcr:enabled-plugins';

function loadIdSet(key: string): Set<string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function saveIdSet(key: string, ids: Set<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    /* ignore storage errors */
  }
}

class PluginRegistry {
  private plugins = new Map<string, RegisteredEntry>();
  private disabled = loadIdSet(DISABLED_KEY);
  private explicitlyEnabled = loadIdSet(ENABLED_KEY);
  private topTabs: Array<{ pluginId: string; item: TopTabPlugin }> = [];
  private paneTypes = new Map<string, { pluginId: string; item: PaneTypePlugin }>();
  private sidebarSections: Array<{ pluginId: string; item: SidebarSectionPlugin }> = [];
  private emptyActions: Array<{ pluginId: string; item: EmptyActionPlugin }> = [];
  private sessionEnrichers: Array<{ pluginId: string; item: SessionEnricher }> = [];
  private appWrappers: Array<{ pluginId: string; item: AppWrapperPlugin }> = [];
  private globalOverlays: Array<{ pluginId: string; item: GlobalOverlayPlugin }> = [];
  private settingsTabs: Array<{ pluginId: string; item: SettingsTabPlugin }> = [];
  private overrides = new Map<OverrideSlot, { pluginId: string; render: ComponentOverrideMap[OverrideSlot] }>();
  private listeners = new Map<PluginEventName, Set<(payload: never) => void>>();
  private changeSubscribers = new Set<() => void>();

  subscribe(fn: () => void): () => void {
    this.changeSubscribers.add(fn);
    return () => { this.changeSubscribers.delete(fn); };
  }

  private notify(): void {
    this.changeSubscribers.forEach(fn => fn());
  }

  register(plugin: McrPlugin): void {
    if (this.plugins.has(plugin.id)) this.unregister(plugin.id);
    const entry: RegisteredEntry = { plugin, cleanup: [] };
    this.plugins.set(plugin.id, entry);
    if (plugin.defaultDisabled && !this.explicitlyEnabled.has(plugin.id)) {
      this.disabled.add(plugin.id);
    }
    if (!this.disabled.has(plugin.id)) {
      this.activate(entry);
    }
    this.notify();
  }

  unregister(pluginId: string): void {
    const entry = this.plugins.get(pluginId);
    if (!entry) return;
    this.deactivate(entry);
    this.plugins.delete(pluginId);
    this.notify();
  }

  isEnabled(pluginId: string): boolean {
    return !this.disabled.has(pluginId);
  }

  setEnabled(pluginId: string, enabled: boolean): void {
    const entry = this.plugins.get(pluginId);
    if (enabled) {
      this.disabled.delete(pluginId);
      this.explicitlyEnabled.add(pluginId);
      saveIdSet(DISABLED_KEY, this.disabled);
      saveIdSet(ENABLED_KEY, this.explicitlyEnabled);
      if (entry && entry.cleanup.length === 0) this.activate(entry);
    } else {
      this.disabled.add(pluginId);
      this.explicitlyEnabled.delete(pluginId);
      saveIdSet(DISABLED_KEY, this.disabled);
      saveIdSet(ENABLED_KEY, this.explicitlyEnabled);
      if (entry) this.deactivate(entry);
    }
    this.notify();
  }

  listPlugins(): Array<McrPlugin & { enabled: boolean }> {
    return [...this.plugins.values()].map(({ plugin }) => ({
      ...plugin,
      enabled: !this.disabled.has(plugin.id),
    }));
  }

  getTopTabs(): TopTabPlugin[] {
    return [...this.topTabs]
      .sort((a, b) => (a.item.order ?? 100) - (b.item.order ?? 100))
      .map(x => x.item);
  }

  getPaneType(kind: string): PaneTypePlugin | undefined {
    return this.paneTypes.get(kind)?.item;
  }

  getSidebarSections(): SidebarSectionPlugin[] {
    return [...this.sidebarSections]
      .sort((a, b) => (a.item.order ?? 100) - (b.item.order ?? 100))
      .map(x => x.item);
  }

  getEmptyActions(): EmptyActionPlugin[] {
    return [...this.emptyActions]
      .sort((a, b) => (a.item.order ?? 100) - (b.item.order ?? 100))
      .map(x => x.item);
  }

  getSessionEnrichers(): SessionEnricher[] {
    return this.sessionEnrichers.map(x => x.item);
  }

  getAppWrappers(): AppWrapperPlugin[] {
    return [...this.appWrappers]
      .sort((a, b) => (a.item.order ?? 100) - (b.item.order ?? 100))
      .map(x => x.item);
  }

  getGlobalOverlays(): GlobalOverlayPlugin[] {
    return [...this.globalOverlays]
      .sort((a, b) => (a.item.order ?? 100) - (b.item.order ?? 100))
      .map(x => x.item);
  }

  getSettingsTabs(): SettingsTabPlugin[] {
    return [...this.settingsTabs]
      .sort((a, b) => (a.item.order ?? 100) - (b.item.order ?? 100))
      .map(x => x.item);
  }

  getOverride<K extends OverrideSlot>(slot: K): ComponentOverrideMap[K] | undefined {
    return this.overrides.get(slot)?.render as ComponentOverrideMap[K] | undefined;
  }

  onEvent<E extends PluginEventName>(event: E, handler: (payload: PluginEventMap[E]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const fn = handler as (payload: never) => void;
    set.add(fn);
    return () => { set?.delete(fn); };
  }

  emitEvent<E extends PluginEventName>(event: E, payload: PluginEventMap[E]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        (handler as (p: PluginEventMap[E]) => void)(payload);
      } catch (err) {
        console.error(`[plugin-event:${event}]`, err);
      }
    }
  }

  private activate(entry: RegisteredEntry): void {
    const pluginId = entry.plugin.id;
    const api: PluginApi = {
      registerTopTab: (tab) => {
        this.topTabs.push({ pluginId, item: tab });
        entry.cleanup.push(() => {
          this.topTabs = this.topTabs.filter(x => !(x.pluginId === pluginId && x.item.id === tab.id));
        });
      },
      registerPaneType: (pane) => {
        this.paneTypes.set(pane.kind, { pluginId, item: pane });
        entry.cleanup.push(() => {
          const cur = this.paneTypes.get(pane.kind);
          if (cur?.pluginId === pluginId) this.paneTypes.delete(pane.kind);
        });
      },
      registerSidebarSection: (section) => {
        this.sidebarSections.push({ pluginId, item: section });
        entry.cleanup.push(() => {
          this.sidebarSections = this.sidebarSections.filter(x => !(x.pluginId === pluginId && x.item.id === section.id));
        });
      },
      registerEmptyAction: (action) => {
        this.emptyActions.push({ pluginId, item: action });
        entry.cleanup.push(() => {
          this.emptyActions = this.emptyActions.filter(x => !(x.pluginId === pluginId && x.item.id === action.id));
        });
      },
      registerSessionEnricher: (enricher) => {
        this.sessionEnrichers.push({ pluginId, item: enricher });
        entry.cleanup.push(() => {
          this.sessionEnrichers = this.sessionEnrichers.filter(x => !(x.pluginId === pluginId && x.item.id === enricher.id));
        });
      },
      registerAppWrapper: (wrapper) => {
        this.appWrappers.push({ pluginId, item: wrapper });
        entry.cleanup.push(() => {
          this.appWrappers = this.appWrappers.filter(x => !(x.pluginId === pluginId && x.item.id === wrapper.id));
        });
      },
      registerGlobalOverlay: (overlay) => {
        this.globalOverlays.push({ pluginId, item: overlay });
        entry.cleanup.push(() => {
          this.globalOverlays = this.globalOverlays.filter(x => !(x.pluginId === pluginId && x.item.id === overlay.id));
        });
      },
      registerSettingsTab: (tab) => {
        this.settingsTabs.push({ pluginId, item: tab });
        entry.cleanup.push(() => {
          this.settingsTabs = this.settingsTabs.filter(x => !(x.pluginId === pluginId && x.item.id === tab.id));
        });
      },
      overrideComponent: (slot, render) => {
        this.overrides.set(slot, { pluginId, render });
        entry.cleanup.push(() => {
          const cur = this.overrides.get(slot);
          if (cur?.pluginId === pluginId) this.overrides.delete(slot);
        });
      },
      onEvent: (event, handler) => {
        let set = this.listeners.get(event);
        if (!set) {
          set = new Set();
          this.listeners.set(event, set);
        }
        const fn = handler as (payload: never) => void;
        set.add(fn);
        const off = () => { set?.delete(fn); };
        entry.cleanup.push(off);
        return off;
      },
      emitEvent: (event, payload) => this.emitEvent(event, payload),
    };

    const userCleanup = entry.plugin.setup(api);
    if (typeof userCleanup === 'function') {
      entry.cleanup.push(userCleanup);
    }
  }

  private deactivate(entry: RegisteredEntry): void {
    while (entry.cleanup.length > 0) {
      const fn = entry.cleanup.pop();
      try { fn?.(); } catch { /* ignore */ }
    }
  }
}

export const pluginRegistry = new PluginRegistry();

export function createPlugin(plugin: McrPlugin): McrPlugin {
  return plugin;
}
