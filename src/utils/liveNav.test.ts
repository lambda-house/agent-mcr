// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMenu, commandContext, menuCommands } from './commands';
import { liveNav } from './liveNav';
import { useReader } from '../reader';

describe('Back and Forward commands (MCR-108)', () => {
  afterEach(() => { liveNav.current = null; });
  const command = (id: string) => menuCommands(buildMenu()).find(c => c.id === id)!;

  it('go through the Live view\'s history while it is shown', () => {
    const back = vi.fn(); const forward = vi.fn();
    liveNav.current = { canBack: () => true, canForward: () => false, back, forward };
    const navigateBack = vi.spyOn(useReader.getState(), 'navigateBack');
    expect(command('tabs.back').enabled!(commandContext())).toBe(true);
    expect(command('tabs.forward').enabled!(commandContext())).toBe(false);
    command('tabs.back').run();
    command('tabs.forward').run();
    expect([back.mock.calls.length, forward.mock.calls.length]).toEqual([1, 1]);
    expect(navigateBack).not.toHaveBeenCalled();
  });

  it('go through the document tabs otherwise', () => {
    const navigateBack = vi.fn();
    useReader.setState({ navigateBack });
    command('tabs.back').run();
    expect(navigateBack).toHaveBeenCalledTimes(1);
  });
});
