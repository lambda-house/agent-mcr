/** Path display helpers accept both native separator styles. */
export function basename(path: string): string {
  return path.split(/[\\/]+/).filter(Boolean).pop() || path;
}

export function parentPath(path: string): string {
  const clean = path.replace(/[\\/]+$/, '');
  const at = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
  if (at < 0) return '';
  if (at === 2 && /^[A-Za-z]:/.test(clean)) return clean.slice(0, 3);
  return clean.slice(0, at) || clean.slice(0, 1);
}

export function homePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, '~')
    .replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+/i, '~');
}

export function tildePath(path: string, home: string): string {
  if (!home) return path;
  const prefix = home.replace(/[\\/]+$/, '');
  if (path === prefix) return '~';
  return path.startsWith(prefix) && /^[\\/]/.test(path.slice(prefix.length)) ? `~${path.slice(prefix.length)}` : path;
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}
