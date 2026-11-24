import React, { useCallback } from 'react';
import {
  PanelLeft,
  List,
} from 'lucide-react';
import { useStore, panelShown } from '../store';
import { DocumentTools, DocumentZoom } from '@lambda-house/reader';
import clsx from 'clsx';
import { ShellTools, useCommandTitle } from '@lambda-house/workbench';

// ============================================================
// Toolbar Component
// ============================================================

// The Documents surface's tools in the window's top bar (the workbench Shell):
// after the main menu, and at the right before the palette, settings and theme (the Workbench's).
interface ToolbarProps {
  filePanelVisible?: boolean;
  /** Absent in a memory reader window: it has no list */
  onToggleFilePanel?: () => void;
}

const Toolbar: React.FC<ToolbarProps> = ({
  filePanelVisible,
  onToggleFilePanel,
}) => {
  const tocVisible = useStore((s) => panelShown(s, 'contents'));
  const toggleTocVisible = useStore((s) => s.toggleTocVisible);
  // The tooltips name the keys of the menu's commands
  const filesTitle = useCommandTitle('view.filePanel', 'Agent documents');
  const contentsTitle = useCommandTitle('view.toc', 'Contents');

  const handleToggleToc = useCallback(() => {
    toggleTocVisible();
  }, [toggleTocVisible]);

  return (
    <>
    <ShellTools>
      {onToggleFilePanel && <div className="wb-tool-group">
        <button
          className={clsx('wb-tool', filePanelVisible && 'active')}
          onClick={onToggleFilePanel}
          title={filesTitle}
        >
          <PanelLeft size={16} />
        </button>
      </div>}

      <div className="wb-tool-separator" />
      
      {/* Center Section */}
      <div className="wb-tool-group">
        <DocumentTools />
      </div>
    </ShellTools>

    <ShellTools side="end">
      <div className="wb-tool-group">
        <DocumentZoom />
      </div>
      
      <div className="wb-tool-separator" />
      
      <div className="wb-tool-group">
        <button
          className={clsx('wb-tool', tocVisible && 'active')}
          onClick={handleToggleToc}
          title={contentsTitle}
        >
          <List size={16} />
        </button>
      </div>
    </ShellTools>
    </>
  );
};

export default Toolbar;
