/** Own a screen lock for one download, independently of the tracking session's lock. */
export function keepDownloadScreenAwake(onChange: (awake: boolean) => void): () => void {
  let active = true;
  let pending = false;
  let lock: WakeLockSentinel | null = null;
  const release = (sentinel: WakeLockSentinel) => { void sentinel.release().catch(() => undefined); };
  const acquire = async () => {
    if (!active || pending || lock || document.visibilityState !== 'visible') return;
    if (!navigator.wakeLock) { onChange(false); return; }
    pending = true;
    try {
      const sentinel = await navigator.wakeLock.request('screen');
      if (!active || document.visibilityState !== 'visible') { release(sentinel); return; }
      if (sentinel.released) { onChange(false); return; }
      lock = sentinel;
      sentinel.addEventListener('release', () => {
        if (lock !== sentinel) return;
        lock = null;
        if (active) onChange(false);
      }, { once: true });
      onChange(true);
    } catch {
      if (active) onChange(false);
    } finally {
      pending = false;
    }
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') void acquire();
    else if (lock) {
      const previous = lock;
      lock = null;
      release(previous);
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  void acquire();
  return () => {
    active = false;
    document.removeEventListener('visibilitychange', onVisibility);
    if (lock) { release(lock); lock = null; }
  };
}
