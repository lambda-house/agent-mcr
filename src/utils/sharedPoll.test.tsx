// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sharedPoll } from './sharedPoll';

beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it('reads once for every pane that shows the data, and only while one does', () => {
  const read = vi.fn();
  const usePoll = sharedPoll(read, 3000);
  const Pane = ({ active }: { active: boolean }) => { usePoll(active); return null; };
  const host = document.createElement('div');
  const root = createRoot(host);
  act(() => root.render(<><Pane active/><Pane active/><Pane active={false}/></>));
  expect(read).toHaveBeenCalledTimes(1);
  act(() => { vi.advanceTimersByTime(3000); });
  expect(read).toHaveBeenCalledTimes(2);
  // One goes: the other still reads
  act(() => root.render(<><Pane active/><Pane active={false}/><Pane active={false}/></>));
  act(() => { vi.advanceTimersByTime(3000); });
  expect(read).toHaveBeenCalledTimes(3);
  // None shown: nothing is read
  act(() => root.render(<><Pane active={false}/></>));
  act(() => { vi.advanceTimersByTime(9000); });
  expect(read).toHaveBeenCalledTimes(3);
  // Shown again: read at once
  act(() => root.render(<><Pane active/></>));
  expect(read).toHaveBeenCalledTimes(4);
  act(() => root.unmount());
});
