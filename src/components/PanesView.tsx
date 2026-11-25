import { useCallback, useMemo } from 'react';
import { SquareDashed } from 'lucide-react';
import { LayoutView, Pane, usePane, usePaneTypes, type Layout, type PaneType } from '@lambda-house/workbench';
import { pluginRegistry } from '../plugins';
import { EMPTY_PANE, useSessionsLayout, type PanesView as View } from '../sessionsLayout';
import { PANEL_MIN } from './BoardView';

// Board and Slack as layouts of panels (shared UI spec §5.3–5.4): each panel
// splits, joins, swaps and closes through its menu (⋯), and its title is a
// menu of the panels it can turn into. A split adds an empty pane, which asks
// which panel to show. Every view of Sessions with panes (Live too) can show
// any of them; the layouts are kept per viewer (sessionsLayout.ts).

/** What each panel shows, under its name in an empty pane. */
export const PANEL_ABOUT: Record<string, string> = {
  'live-sessions': 'The hosted sessions, by folder',
  'board-reports': 'What sessions reported to you',
  'board-notes': 'Notes sessions read when they start',
  'slack-waiting': 'Slack posts that wait for your approval',
  'slack-posts': 'What sessions asked to post in Slack',
  'slack-received': 'Messages from listened Slack channels',
  'slack-connection': 'Slack’s connection and its channels',
};

/** The panels this pane can turn into, one button each (the type menu's items), under `heading` if given; nothing when every panel is shown. */
export function PanelChoices({ heading }: { heading?: string }) {
  const pane = usePane();
  const types = pane?.actions.types ?? [];
  if (!pane || !types.length) return null;
  const choices = <div className="hs-empty-actions" role="group" aria-label="Show a panel here">
    {types.map(t => <button key={t.type} type="button" className="hs-empty-action" onClick={() => pane.actions.setType(t.type)}>
      {t.icon}
      <span><strong>{t.title}</strong>{PANEL_ABOUT[t.type] && <small>{PANEL_ABOUT[t.type]}</small>}</span>
    </button>)}
  </div>;
  return heading ? <div className="hs-empty-panels"><h4>{heading}</h4>{choices}</div> : choices;
}

/** An empty pane of Board or Slack: which panel to show here. */
function EmptyPanel() {
  const choices = (usePane()?.actions.types.length ?? 0) > 0;
  return <Pane className="hs-board hs-empty-pane" title="Empty pane">
    <div className="hs-pane-empty">
      <div className="hs-empty-card">
        <div className="hs-empty-head">
          <div>
            <h3>Show in this pane</h3>
            <p>Pick a panel. Its title switches it to another one later.</p>
          </div>
        </div>
        <PanelChoices/>
        {!choices && <p className="hs-empty-none">Every panel is shown already. Close this pane, or switch another one here from its title.</p>}
      </div>
    </div>
  </Pane>;
}

/** The empty pane of Board and Slack; Live has its own, which also opens sessions. */
export const emptyPane: PaneType = {
  type: EMPTY_PANE, label: 'empty pane', title: 'Empty pane', icon: <SquareDashed size={14}/>, placeholder: true, min: PANEL_MIN,
  render: () => <EmptyPanel/>,
};

/** Board or Slack: the view's layout, its panes from the plugins (the app's panels and the empty pane). */
export default function PanesView({ view }: { view: Exclude<View, 'live'> }) {
  const root = useSessionsLayout(s => s.layouts[view]);
  const focused = useSessionsLayout(s => s.focused[view]);
  const paneTypes = usePaneTypes(pluginRegistry.workbench, view);
  const layout = useMemo<Layout>(() => ({ version: 1, root }), [root]);
  const onChange = useCallback((next: Layout) => useSessionsLayout.getState().setLayout(view, next.root), [view]);
  const onFocusLeaf = useCallback((leaf: string) => useSessionsLayout.getState().focus(view, leaf), [view]);
  const onReset = useCallback(() => useSessionsLayout.getState().reset(view), [view]);
  return <LayoutView className="hs-panes" layout={layout} onChange={onChange} paneTypes={paneTypes} focusedLeaf={focused} onFocusLeaf={onFocusLeaf} onReset={onReset}/>;
}
