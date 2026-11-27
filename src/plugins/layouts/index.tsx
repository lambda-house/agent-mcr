import { Columns2, LayoutGrid, Square } from 'lucide-react';
import { createPlugin } from '../sdk';

/**
 * Live's presets, among the view's tools in the top bar: the list beside one
 * pane, two columns or a 2×2 grid. Each pane splits, joins, swaps and closes
 * through its own menu (⋯), the workbench's.
 */
export const plugin = createPlugin({
  id: 'layouts',
  name: 'Layouts',
  version: '1.1.0',
  description: 'Lay out Live at once: the session list beside one pane, two columns or a 2×2 grid.',
  setup(api) {
    api.overrideComponent('live:layout-bar', ({ leavesCount, controller }) => (
      controller.opened.length >= 2 || leavesCount > 1 ? (
        <div className="wb-tool-group hs-layout-bar" role="toolbar" aria-label="Pane layout">
          <button type="button" className={`wb-tool${leavesCount === 1 ? ' active' : ''}`} title="Single pane" aria-label="Single pane" onClick={() => controller.applyPreset('1')}><Square size={14}/></button>
          <button type="button" className={`wb-tool${leavesCount === 2 ? ' active' : ''}`} title="Two columns" aria-label="Two columns" onClick={() => controller.applyPreset('2-col')}><Columns2 size={14}/></button>
          <button type="button" className={`wb-tool${leavesCount >= 4 ? ' active' : ''}`} title="2×2 grid" aria-label="2×2 grid" onClick={() => controller.applyPreset('2x2')}><LayoutGrid size={14}/></button>
        </div>
      ) : null
    ));
  },
});
