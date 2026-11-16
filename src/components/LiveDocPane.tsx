import React, { useEffect, useState } from 'react';
import { AlertCircle, Save } from 'lucide-react';
import clsx from 'clsx';
import { useStore } from '../store';
import { ErrorBoundary, MarkdownViewer } from './DocumentPanel';
import { getFileKind, getFileName } from '../utils/files';
import { saveDocumentToDisk } from '../utils/save';
import { readFile } from '../utils/tauri';

const Editor = React.lazy(() => import('./Editor'));

export default function LiveDocPane({
  path,
  editing,
}: {
  path: string;
  editing: boolean;
}) {
  const doc = useStore(s => s.documents[path]);
  const zoom = useStore(s => s.zoom);
  const openDocument = useStore(s => s.openDocument);
  const updateDocumentContent = useStore(s => s.updateDocumentContent);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    if (doc !== undefined) return;
    let cancelled = false;
    setLoadError('');
    readFile(path)
      .then(content => {
        if (!cancelled) openDocument(path, content, { preview: false });
      })
      .catch(e => {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => { cancelled = true; };
  }, [path, doc, openDocument]);

  if (loadError) {
    return (
      <div className="hs-doc-empty">
        <AlertCircle size={22}/>
        <p>{loadError}</p>
      </div>
    );
  }

  if (!doc) {
    return <div className="hs-doc-empty"><p>Loading {getFileName(path)}…</p></div>;
  }

  const kind = getFileKind(path).kind;
  const showEditor = editing;
  const showPreview = !showEditor || kind === 'markdown' || kind === 'fb2';

  return (
    <div className={clsx('hs-doc-pane', showEditor && showPreview && 'split')}>
      {showEditor && (
        <div className="editor-pane">
          <div className="editor-header">
            <span className="editor-header-title" title={path}>{getFileName(path)}</span>
            <span className={clsx('editor-header-status', doc.isDirty && 'dirty')}>
              {doc.isDirty ? 'Unsaved changes' : 'Saved'}
            </span>
            <button
              className="editor-save-button"
              onClick={() => void saveDocumentToDisk(path)}
              disabled={!doc.isDirty}
              title="Save (Ctrl+S)"
              type="button"
            >
              <Save size={13}/> Save
            </button>
          </div>
          <React.Suspense fallback={<div className="editor-host editor-loading">Loading editor…</div>}>
            <Editor
              path={path}
              content={doc.content}
              zoom={zoom}
              onChange={(nextContent) => {
                updateDocumentContent(path, nextContent);
              }}
              onSave={() => void saveDocumentToDisk(path)}
            />
          </React.Suspense>
        </div>
      )}
      {showPreview && (
        <div className="document-content hs-doc-scroll" style={{ '--zoom-factor': zoom / 100 } as React.CSSProperties}>
          <div className="document-content-inner">
            <ErrorBoundary
              fallback={
                <div className="render-error">
                  <AlertCircle size={28}/>
                  <h3>Failed to render document</h3>
                  <p>There was an error rendering this file.</p>
                </div>
              }
            >
              <MarkdownViewer content={doc.content} documentPath={path}/>
            </ErrorBoundary>
          </div>
        </div>
      )}
    </div>
  );
}
