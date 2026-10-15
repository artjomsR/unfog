import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { retrySectionFetch } from './download-retry';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('keeps retrying Load failed beyond the old retry limit, with capped backoff', async () => {
  const task = vi.fn().mockRejectedValue(new TypeError('Load failed'));
  const report = vi.fn(), abort = new AbortController();
  const result = retrySectionFetch(task, abort.signal, report);
  await vi.advanceTimersByTimeAsync(0);
  for (const delay of [15000, 30000, 60000, 120000, 120000, 120000, 120000]) {
    expect(report).toHaveBeenLastCalledWith(expect.stringContaining(`retrying in ${delay / 1000} s`));
    await vi.advanceTimersByTimeAsync(delay);
  }
  expect(task).toHaveBeenCalledTimes(8);
  task.mockResolvedValue('roads');
  await vi.advanceTimersByTimeAsync(120000);
  await expect(result).resolves.toBe('roads');
});

it('waits offline and resumes without a manual retry', async () => {
  const nav = { onLine: false };
  vi.stubGlobal('navigator', nav);
  const task = vi.fn().mockResolvedValue('roads'), report = vi.fn();
  const result = retrySectionFetch(task, new AbortController().signal, report);
  await vi.advanceTimersByTimeAsync(60000);
  expect(task).not.toHaveBeenCalled();
  expect(report).toHaveBeenLastCalledWith(expect.stringContaining('Waiting for connection'));
  nav.onLine = true;
  await vi.advanceTimersByTimeAsync(15000);
  await expect(result).resolves.toBe('roads');
});

it('cancels a retry wait promptly and does not start another attempt', async () => {
  const task = vi.fn().mockRejectedValue(new TypeError('Load failed'));
  const abort = new AbortController();
  const result = retrySectionFetch(task, abort.signal, vi.fn());
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(0);
  abort.abort();
  await rejected;
  await vi.advanceTimersByTimeAsync(120000);
  expect(task).toHaveBeenCalledTimes(1);
});

it('does not retry a permanent HTTP error', async () => {
  const error = Object.assign(new Error('Bad query'), { status: 400 });
  const task = vi.fn().mockRejectedValue(error);
  await expect(retrySectionFetch(task, new AbortController().signal, vi.fn())).rejects.toBe(error);
  expect(task).toHaveBeenCalledTimes(1);
});
