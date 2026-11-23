import { expect, it, vi } from 'vitest';
import { documentWindowReaderStorage, documentWindowStorage } from './documentWindow';
import { findPaneOfType } from '@lambda-house/workbench';
import { defaultDocumentsLayout } from '../store/documentsLayout';

it('inherits display preferences without restoring or overwriting the main workspace', () => {
  const getItem = vi.fn(() => JSON.stringify({version:4,state:{theme:'light',zoom:125,tabs:[{path:'/main.md'}],directories:['/work'],editMode:true}}));
  const storage = documentWindowStorage({getItem});
  const {state} = JSON.parse(storage.getItem());
  expect(state.theme).toBe('light');
  expect(state.tabs).toBeUndefined();
  expect(state.directories).toBeUndefined();
  expect(findPaneOfType(state.documentsLayout, 'agent-docs')).toBeUndefined();
  storage.setItem();
  storage.removeItem();
  expect(JSON.parse(storage.getItem()).state).toEqual(state);
});

it('can open with defaults when persisted preferences are malformed', () => {
  expect(findPaneOfType(JSON.parse(documentWindowStorage({getItem:()=>'{broken'}).getItem()).state.documentsLayout, 'agent-docs')).toBeUndefined();
  expect(JSON.parse(documentWindowReaderStorage({getItem:()=>'{broken'}).getItem()).state.editMode).toBe(false);
});

it('gives the reader the main window\'s reader settings and zoom, without its tabs', () => {
  const saved = { version: 1, state: { focusedGroup: 'g', groups: { g: { id: 'g', zoom: 125, tabs: [{ path: '/main.md' }] } }, settings: { smoothScroll: false }, editMode: true } };
  const storage = documentWindowReaderStorage({ getItem: () => JSON.stringify(saved) });
  const { state } = JSON.parse(storage.getItem());
  expect(state.groups.main).toEqual({ id: 'main', zoom: 125, tabs: [], activeTabId: null });
  expect(state.settings).toEqual({ smoothScroll: false });
  expect(state.editMode).toBe(false);
});

it('keeps the main window\'s contents panel and leaves out the agent documents', () => {
  const layout = defaultDocumentsLayout({ tocWidth: 300 });
  const { state } = JSON.parse(documentWindowStorage({ getItem: () => JSON.stringify({ version: 7, state: { documentsLayout: layout } }) }).getItem());
  expect(findPaneOfType(state.documentsLayout, 'agent-docs')).toBeUndefined();
  expect(state.documentsLayout.sizes).toEqual([{ fr: 1 }, { px: 300 }]);
  const old = JSON.parse(documentWindowStorage({ getItem: () => JSON.stringify({ version: 6, state: { tocWidth: 250, tocVisible: false } }) }).getItem()).state;
  expect(findPaneOfType(old.documentsLayout, 'contents')?.collapsed).toBe(true);
  expect(old.documentsLayout.sizes).toEqual([{ fr: 1 }, { px: 250 }]);
});
