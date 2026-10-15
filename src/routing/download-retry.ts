/** Keep transient network failures out of the section download's terminal error path. */
export async function retrySectionFetch<T>(task: () => Promise<T>, signal: AbortSignal, report: (note: string) => void): Promise<T> {
  let failures = 0;
  for (;;) {
    signal.throwIfAborted();
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      report('Waiting for connection — saved sections are safe; will resume automatically');
      await wait(15_000, signal);
      continue;
    }
    try {
      return await task();
    } catch (error) {
      signal.throwIfAborted();
      const status = (error as { status?: number })?.status;
      // Invalid requests/authentication need intervention, not an endless retry loop.
      if (status !== undefined && status < 500 && status !== 408 && status !== 429) throw error;
      const delay = Math.min(120_000, 15_000 * 2 ** Math.min(failures++, 3));
      report(`Connection or map server interrupted — retrying in ${delay / 1000} s. Saved sections are safe.`);
      await wait(delay, signal);
    }
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      globalThis.removeEventListener?.('online', onOnline);
    };
    const onAbort = () => { cleanup(); reject(signal.reason); };
    const onOnline = () => { cleanup(); resolve(); };
    const timer = setTimeout(onOnline, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    globalThis.addEventListener?.('online', onOnline, { once: true });
    if (signal.aborted) onAbort();
  });
}
