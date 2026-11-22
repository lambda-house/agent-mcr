import { useEffect, useRef, useState } from 'react';
import { SettingRow } from '@lambda-house/ui';
import { memoryApi, memoryStateLine, type MemoryStatus } from '../utils/harness';

const POLL_MS = 1500;

/** Settings: the memory server's connection (D16). Connecting and disconnecting ask in a native dialog. */
export default function MemoryConnection() {
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    memoryApi.status().then(s => { if (alive.current) setStatus(s); }).catch(e => { if (alive.current) setError(String(e)); });
    return () => { alive.current = false; };
  }, []);
  // The sign-in ends in the browser: ask the service until it is over
  const connecting = status?.state === 'connecting';
  useEffect(() => {
    if (!connecting) return;
    const timer = setInterval(() => {
      memoryApi.status().then(s => { if (alive.current) setStatus(s); }).catch(() => {});
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [connecting]);

  const run = async (action: () => Promise<MemoryStatus>) => {
    setBusy(true); setError('');
    try { const next = await action(); if (alive.current) setStatus(next); }
    catch (e) { if (alive.current) setError(String(e)); }
    finally { if (alive.current) setBusy(false); }
  };

  const off = !status || status.state === 'disconnected' || status.state === 'signed_out';
  return <div className="settings-section">
    <div className="settings-section-head">
      <h3>Memory for agents <small className="hs-preview">Preview</small></h3>
      <p className="settings-section-description">One shared memory for every agent session Agent MCR starts. You sign in once; the sign-in stays in the macOS Keychain and no agent sees it.</p>
    </div>
    {error && <p role="alert">{error}</p>}
    {status && <div className="settings-card">
      <SettingRow label="Connection" description={memoryStateLine(status)} control={
        off
          ? <button type="button" disabled={busy} onClick={() => void run(memoryApi.connect)}>{status.state === 'signed_out' ? 'Sign in again…' : 'Connect…'}</button>
          : <button type="button" disabled={busy} onClick={() => void run(memoryApi.disconnect)}>{connecting ? 'Cancel sign-in' : 'Disconnect…'}</button>
      }/>
      {status.problem && <SettingRow label="Last problem" description={`${status.problem.text} (${new Date(status.problem.at).toLocaleString()})`} control={null}/>}
    </div>}
  </div>;
}
