import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from './context';
import type { SessionState } from '../record/session';

const { choose } = vi.hoisted(() => ({ choose: vi.fn() }));
vi.mock('./ui', () => ({
  confirmSheet: choose,
  el: () => ({ appendChild() {}, remove() {}, className: '', textContent: '', hidden: false }),
  svg: () => ({}), toast: vi.fn(),
}));
const storage = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) },
  document: { addEventListener() {}, visibilityState: 'visible' },
  window: globalThis,
});
const { createTracking } = await import('./tracking');
const { updateSettings } = await import('./settings');
const { SESSION_KEY, PENDING_SESSIONS_KEY, loadUnfinishedSession } = await import('../record/session');
const journey = (): SessionState => ({ id: 'interrupted', startMs: Date.now() - 86400000, points: [[-73.95, 40.71, 1000], [-73.9499, 40.71, 6000]], distanceM: 8, newCells: 2, dropped: 0, lastCheckpointMs: 1000 });

function setup(fail = false, hasRoute = false) {
  const recorder = {
    status: 'idle', state: null as SessionState | null,
    start: vi.fn(async (state?: SessionState) => { recorder.state = state ?? { ...journey(), id: 'new' }; recorder.status = 'recording'; }),
    stop: vi.fn(),
  };
  const markTrack = vi.fn(async () => { if (fail) throw new Error('storage unavailable'); });
  const ctx = {
    recorder, location: { supported: true, onError() {}, isRetained: () => true },
    shell: { bannerHost: { appendChild() {} } },
    engines: { grid: { markTrack }, gridMock: false },
    dataChanged: vi.fn(),
  } as unknown as AppContext;
  const routes = { hasSavedJourney: () => hasRoute, restoreJourney: vi.fn(), discardSavedJourney: vi.fn(() => { hasRoute = false; }) };
  const tracking = createTracking(ctx, { onUpdate() {}, onWakeLock() {} }, routes);
  return { tracking, recorder, markTrack, ctx, routes };
}
beforeEach(() => {
  vi.useFakeTimers(); storage.clear(); choose.mockReset(); updateSettings({ tracking: true });
});
afterEach(() => vi.useRealTimers());

describe('journey recovery on boot', () => {
  it('keeps the saved journey intact while waiting, then resumes the same journey even across midnight', async () => {
    storage.set(SESSION_KEY, JSON.stringify(journey()));
    let decide!: (value: boolean) => void;
    choose.mockImplementation(() => new Promise<boolean>((resolve) => { decide = resolve; }));
    const { tracking, recorder, markTrack } = setup(false, true);
    const boot = tracking.resume();
    expect(loadUnfinishedSession()?.id).toBe('interrupted');
    expect(recorder.start).not.toHaveBeenCalled();
    expect(choose).toHaveBeenCalledWith(expect.objectContaining({ dismissible: false, okLabel: 'Resume journey' }));
    await tracking.resume(); // repeated boot calls must not duplicate the prompt
    expect(choose).toHaveBeenCalledTimes(1);
    decide(true);
    await boot;
    expect(recorder.start).toHaveBeenCalledWith(expect.objectContaining({ id: 'interrupted', distanceM: 8 }));
    expect(markTrack).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000);
    expect(recorder.stop).not.toHaveBeenCalled();
  });

  it('saves the old journey before starting a new one when declined', async () => {
    storage.set(SESSION_KEY, JSON.stringify(journey()));
    choose.mockResolvedValue(false);
    const { tracking, recorder, markTrack } = setup(false, true);
    await tracking.resume();
    expect(markTrack).toHaveBeenCalledWith(expect.objectContaining({ id: 'interrupted' }));
    expect(recorder.start).toHaveBeenCalledWith(undefined);
    expect(loadUnfinishedSession()).toBeNull();
  });

  it('keeps a declined journey pending if the database save fails', async () => {
    storage.set(SESSION_KEY, JSON.stringify(journey()));
    choose.mockResolvedValue(false);
    const { tracking, recorder } = setup(true, true);
    await tracking.resume();
    expect(JSON.parse(storage.get(PENDING_SESSIONS_KEY)!)[0]).toMatchObject({ id: 'interrupted', ended: true });
    expect(recorder.start).toHaveBeenCalledWith(undefined);
  });

  it.each(['ended', 'empty', 'off'])('does not offer recovery for %s journeys', async (reason) => {
    const old = journey();
    if (reason === 'ended') old.ended = true;
    if (reason === 'empty') old.points = [];
    if (reason === 'off') updateSettings({ tracking: false });
    storage.set(SESSION_KEY, JSON.stringify(old));
    const { tracking, recorder } = setup();
    await tracking.resume();
    expect(choose).not.toHaveBeenCalled();
    expect(recorder.start).toHaveBeenCalledTimes(reason === 'off' ? 0 : 1);
  });

  it('recovers passive recording silently after a declined route and on subsequent boots', async () => {
    storage.set(SESSION_KEY, JSON.stringify(journey()));
    choose.mockResolvedValue(false);
    const declined = setup(false, true);
    await declined.tracking.resume();
    expect(declined.routes.discardSavedJourney).toHaveBeenCalledOnce();
    expect(declined.routes.restoreJourney).not.toHaveBeenCalled();
    expect(choose).toHaveBeenCalledOnce();
    // Automatic recording continues; its next boot is not another navigation journey decision.
    storage.set(SESSION_KEY, JSON.stringify({ ...journey(), id: 'passive-after-decline' }));
    for (let i = 0; i < 2; i++) {
      const next = setup();
      await next.tracking.resume();
      expect(next.recorder.start).toHaveBeenCalledWith(expect.objectContaining({ id: 'passive-after-decline' }));
      expect(choose).toHaveBeenCalledOnce();
    }
    // A genuinely new route still gets a recovery offer.
    const freshRoute = setup(false, true);
    await freshRoute.tracking.resume();
    expect(choose).toHaveBeenCalledTimes(2);
  });

  it('leaves recovery untouched if the real grid is unavailable', async () => {
    storage.set(SESSION_KEY, JSON.stringify(journey()));
    const { tracking, ctx, recorder } = setup();
    ctx.engines.gridMock = true;
    await tracking.resume();
    expect(choose).not.toHaveBeenCalled();
    expect(recorder.start).not.toHaveBeenCalled();
    expect(loadUnfinishedSession()?.id).toBe('interrupted');
  });
});
