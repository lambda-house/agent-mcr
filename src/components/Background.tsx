import { useEffect, useState } from 'react';
import { PLATFORM } from '../utils/platform';
import { harnessApi, type Background, type BackgroundUnit } from '../utils/harness';
import { Button, keepSame } from '@lambda-house/ui';

const err = (e: unknown) => e instanceof Error ? e.message : String(e);

/**
 * Shown instead of the session list while the background processes are not
 * allowed: on a first start, and after the person stopped them. Allowing is
 * asked in a native dialog; this page only opens it.
 */
export function BackgroundGate({ stopped, onAllowed }: { stopped: boolean; onAllowed: () => void }) {
  const [error, setError] = useState('');
  const [asking, setAsking] = useState(false);
  const allow = () => {
    setAsking(true);
    harnessApi.allowBackground().then(ok => { if (ok) onAllowed(); }).catch(e => setError(err(e))).finally(() => setAsking(false));
  };
  return <div className="hs-gate" role="region" aria-label="Background processes">
    <strong>{stopped ? 'Sessions and background processes are stopped' : 'Agent MCR runs agents in the background'}</strong>
    <p>Two processes of its own keep your agents working when you close or update the app: the <b>runner</b> holds their terminals, the <b>harness service</b> tracks sessions and gives agents their tools.</p>
    <p>{PLATFORM === 'windows' ? <>They are ordinary processes of your user that Agent MCR starts itself; nothing is installed in Windows. They listen</> : <>macOS starts them through two files in <code>~/Library/LaunchAgents</code>. They listen</>} only on sockets private to your user, never on the network, and exit ten minutes after the last session ends.</p>
    <p>{stopped ? 'Nothing runs now, and nothing starts until you allow it.' : 'Nothing is installed or started until you allow it. You can stop and remove them here at any time.'}</p>
    <Button variant="primary" size="sm" className="hs-gate-go" disabled={asking} onClick={allow}>{stopped ? 'Start again…' : 'Allow and start…'}</Button>
    {error && <div className="hs-error" role="alert">{error}</div>}
  </div>;
}

const unitLine = (u: BackgroundUnit) => u.running
  ? `pid ${u.pid ?? '?'}${u.version ? ` · ${u.version}` : ''}${u.since ? ` · since ${u.since}` : ''}`
  : 'not running';

/**
 * What runs in the background, since when and from which files, with the
 * person's off switch. Both actions are confirmed in a native dialog.
 */
export function BackgroundPanel({ onStopped }: { onStopped: () => void }) {
  const [background, setBackground] = useState<Background | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => harnessApi.background().then(b => { if (live) setBackground(held => keepSame(held, b)); }).catch(e => { if (live) setError(err(e)); });
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const stop = (uninstall: boolean) => {
    setBusy(true);
    harnessApi.stopBackground(uninstall).then(done => { if (done) onStopped(); }).catch(e => setError(err(e))).finally(() => setBusy(false));
  };
  return <section className="hs-background" aria-label="Background processes">
    <p>These keep sessions running while the app is closed. Quitting the app does not stop them.</p>
    <dl>
      {background?.units.map(u => <div key={u.label}>
        <dt><span className={`hs-dot ${u.running ? 'working' : 'exited'}`} aria-hidden="true"/>{u.name === 'runner' ? 'Runner' : 'Harness service'}</dt>
        <dd>{unitLine(u)}</dd>
        {u.plist && <dd className="hs-background-file" title={u.plist}>{u.installed ? u.plist.replace(/^\/Users\/[^/]+/, '~') : 'no LaunchAgent file'}</dd>}
      </div>)}
    </dl>
    {error && <div className="hs-error" role="alert">{error}</div>}
    <div className="hs-background-actions">
      <Button variant="secondary" size="sm" disabled={busy} title="End every session and stop both processes. Nothing starts them again until you allow it." onClick={() => stop(false)}>Stop everything…</Button>
      <Button variant="secondary" size="sm" disabled={busy} title={PLATFORM === 'windows' ? 'Stop everything and forget the permission. Session history and settings stay.' : 'Stop everything and remove the two LaunchAgent files. Session history and settings stay.'} onClick={() => stop(true)}>Remove background items…</Button>
    </div>
  </section>;
}
