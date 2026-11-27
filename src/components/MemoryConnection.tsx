import { useEffect, useRef, useState } from 'react';
import { SettingRow } from '@lambda-house/ui';
import { canUnlockStore, memoryApi, memoryStateLine, secretStoreName, vaultApi, type MemoryStatus } from '../utils/harness';
import { PLATFORM } from '../utils/platform';

const POLL_MS = 1500;

/** Settings: the memory server's connection (D16). Connecting and disconnecting ask in a native dialog. */
export default function MemoryConnection() {
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  /** The problem the keyring was unlocked for: a later one offers the unlock again */
  const [unlockedFor, setUnlockedFor] = useState<number | null>(null);
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
  // The keyring asks for its password itself; the problem stays until a call reads the sign-in again
  const unlock = async (problemAt: number) => {
    setBusy(true); setError('');
    try { await vaultApi.unlock(); if (alive.current) setUnlockedFor(problemAt); }
    catch (e) { if (alive.current) setError(String(e)); }
    finally { if (alive.current) setBusy(false); }
  };

  const off = !status || status.state === 'disconnected' || status.state === 'signed_out';
  const locked = canUnlockStore(PLATFORM) && status?.problem?.kind === 'vault_unavailable' ? status.problem : null;
  const unlocked = !!locked && locked.at === unlockedFor;
  return <div className="settings-section">
    <div className="settings-section-head">
      <h3>Memory for agents <small className="hs-preview">Preview</small></h3>
      <p className="settings-section-description">One shared memory for every agent session Agent MCR starts. You sign in once; the sign-in stays in {secretStoreName(PLATFORM)} and Agent MCR gives it to no agent.</p>
    </div>
    {error && <p role="alert">{error}</p>}
    {status && <div className="settings-card">
      <SettingRow label="Connection" description={unlocked ? <span role="status">{memoryStateLine(status, true)}</span> : memoryStateLine(status)} control={
        off
          ? <button type="button" disabled={busy} onClick={() => void run(memoryApi.connect)}>{status.state === 'signed_out' ? 'Sign in again…' : 'Connect…'}</button>
          : <button type="button" disabled={busy} onClick={() => void run(memoryApi.disconnect)}>{connecting ? 'Cancel sign-in' : 'Disconnect…'}</button>
      }/>
      {status.problem && <SettingRow label="Last problem" description={`${status.problem.text} (${new Date(status.problem.at).toLocaleString()})`} control={
        locked && !unlocked ? <button type="button" disabled={busy} onClick={() => void unlock(locked.at)}>Unlock keyring…</button> : null
      }/>}
    </div>}
  </div>;
}
