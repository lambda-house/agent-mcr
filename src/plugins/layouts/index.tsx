import { Columns2, LayoutGrid, Rows2, Square, X } from 'lucide-react';
import { createPlugin } from '../sdk';

/** Split panes in Live: the preset bar and each pane's split and close buttons. */
export const plugin = createPlugin({
  id: 'layouts',
  name: 'Layouts',
  version: '1.0.0',
  description: 'Split Live into panes: single, two columns or a 2×2 grid, and split or close any pane.',
  setup(api) {
    api.overrideComponent('live:layout-bar', ({ leavesCount, controller }) => (
      controller.opened.length >= 2 || leavesCount > 1 ? (
        <div className="hs-layout-bar" role="toolbar" aria-label="Pane layout">
          <span className="hs-layout-label">Layout</span>
          <button type="button" className={`hs-layout-btn${leavesCount === 1 ? ' active' : ''}`} title="Single pane" aria-label="Single pane" onClick={() => controller.applyPreset('1')}><Square size={12}/></button>
          <button type="button" className={`hs-layout-btn${leavesCount === 2 ? ' active' : ''}`} title="Two columns" aria-label="Two columns" onClick={() => controller.applyPreset('2-col')}><Columns2 size={12}/></button>
          <button type="button" className={`hs-layout-btn${leavesCount >= 4 ? ' active' : ''}`} title="2×2 grid" aria-label="2×2 grid" onClick={() => controller.applyPreset('2x2')}><LayoutGrid size={12}/></button>
        </div>
      ) : null
    ));
    api.overrideComponent('live:pane-tools', ({ leafId, multiPane, controller }) => (
      <>
        <button type="button" className="hs-pane-btn" aria-label="Split right" title="Split right" onClick={e => { e.stopPropagation(); controller.splitPane(leafId, 'row'); }}><Columns2 size={13}/></button>
        <button type="button" className="hs-pane-btn" aria-label="Split down" title="Split down" onClick={e => { e.stopPropagation(); controller.splitPane(leafId, 'col'); }}><Rows2 size={13}/></button>
        {multiPane && <button type="button" className="hs-pane-btn" aria-label="Close pane" title="Close pane" onClick={e => { e.stopPropagation(); controller.closePane(leafId); }}><X size={13}/></button>}
      </>
    ));
  },
});
