import { describe, expect, it } from 'vitest';
import { basename, homePath, isAbsolutePath, parentPath, tildePath } from './paths';
import { directoryTree, within, type Session } from './sessions';

describe('Windows paths', () => {
  it('displays and recognizes paths', () => {
    expect(basename('C:\\Users\\me\\repo\\')).toBe('repo');
    expect(parentPath('C:\\repo')).toBe('C:\\');
    expect(parentPath('C:\\repo\\src')).toBe('C:\\repo');
    expect(homePath('C:\\Users\\me\\repo')).toBe('~\\repo');
    expect(tildePath('C:\\Users\\me\\repo', 'C:\\Users\\me')).toBe('~\\repo');
    expect(tildePath('C:\\Users\\me2', 'C:\\Users\\me')).toBe('C:\\Users\\me2');
    expect(isAbsolutePath('C:\\repo')).toBe(true);
    expect(isAbsolutePath('C:repo')).toBe(false);
    expect(isAbsolutePath('\\\\server\\share')).toBe(true);
  });
  it('groups and filters recorded directories at boundaries', () => {
    const path = 'C:\\Users\\me\\repo';
    expect(within(path, 'C:\\Users\\me')).toBe(true);
    expect(within(path, 'C:\\Users\\m')).toBe(false);
    const tree = directoryTree([{ cwd: path, id: '1', provider: 'codex' } as Session]);
    expect(tree.children.get('C:')?.path).toBe('C:\\');
    expect(tree.children.get('C:')?.children.get('Users')?.children.get('me')?.children.get('repo')?.path).toBe(path);
  });
});
