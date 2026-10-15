/**
 * The recorder's persistence contract (review-round2 MED-1): a session a previous run left behind
 * is never lost — not when boot cannot write it to the grid, not when a new session starts over
 * it, not when the final markTrack of a Stop fails. New file: src/record had no test; hermetic,
 * fast tier (a src module with no behaviour guard). Node environment with the few browser globals
 * the module touches.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ApplyResult, GridApi } from '../grid/api';
import type { GridStats, Track } from '../grid/types';
import { rasterizeTrack } from '../grid/raster';
import { recordToTrack, trackToRecord } from '../grid/store';
import { jsonToTrackRecord, trackRecordToJson } from '../grid/backup';
import { trackToGpx } from './gpx';
import type { Fix, LocationError } from '../map/location';
import type { LocationManager } from '../map/location';

const storage = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => void storage.set(k, String(v)),
  removeItem: (k: string) => void storage.delete(k),
};
(globalThis as { document?: unknown }).document = { addEventListener() {}, visibilityState: 'visible' };
(globalThis as { window?: unknown }).window = globalThis;

const { MAX_PENDING_SESSIONS, PENDING_SESSIONS_KEY, Recorder, SESSION_KEY, loadPendingSessions, loadUnfinishedSession, saveUnfinishedSession, stashSession } = await import('./session');
type SessionState = import('./session').SessionState;

/** A grid double whose markTrack can be told to fail; records what it was given. */
function grid(fail = () => false): GridApi & { marks: Track[] } {
  const marks: Track[] = [];
  const stats = (): GridStats => ({ visitedCells: 0, areaM2: 0, tiles: 0, version: 0, updatedAt: 0 });
  const result = (): ApplyResult => ({ stats: stats(), touched: [] });
  return {
    marks,
    init: async () => stats(),
    getStats: async () => stats(),
    applyPayload: async () => result(),
    async markTrack(t) {
      if (fail()) throw new Error('IndexedDB unavailable');
      marks.push(structuredClone(t));
      return result();
    },
    renderTile: async () => new Uint8ClampedArray(0),
    getTileCounts: async () => null,
    listBaseTiles: async () => [],
    exportBackup: async () => new Uint8Array(0),
    importBackup: async () => result(),
    listTracks: async () => [],
    getTrack: async () => null,
    deleteTrack: async () => stats(),
    deleteAll: async () => stats(),
  };
}

const location = { onError: () => () => undefined, onFix: () => () => undefined, retain() {}, release() {}, isRetained: () => false } as unknown as LocationManager;
const events = { onUpdate() {}, onWakeLock() {} };
const session = (id: string, n: number): SessionState => ({ id, startMs: 1, points: Array.from({ length: n }, (_, i) => [-73.95 + i * 0.001, 40.71 + i * 0.001, 1 + i * 2000] as [number, number, number]), distanceM: 0, newCells: 0, lastCheckpointMs: 1, dropped: 0 });

beforeEach(() => storage.clear());

describe('unfinished sessions survive a boot that cannot save them', () => {
  it('a failed boot save keeps the session aside; Recorder.start() does not overwrite it; the next boot with a working grid writes it', async () => {
    storage.set(SESSION_KEY, JSON.stringify(session('session-old', 3)));
    const broken = grid(() => true);
    expect(await saveUnfinishedSession(broken)).toBeNull();
    expect(loadUnfinishedSession()).toBeNull(); // out of the running-session slot…
    expect(loadPendingSessions().map((s) => s.id)).toEqual(['session-old']); // …and kept

    const recorder = new Recorder(broken, location, events);
    await recorder.start(); // what tracking.ts does next when the switch is on
    const running = loadUnfinishedSession();
    expect(running?.id).not.toBe('session-old');
    expect(running?.points).toHaveLength(0);
    expect(loadPendingSessions().map((s) => s.id)).toEqual(['session-old']); // still there
    recorder.discard();

    // Next boot, the grid works: the pending session lands on the map under its own id and is forgotten.
    const ok = grid();
    const saved = await saveUnfinishedSession(ok);
    expect(saved?.id).toBe('session-old');
    expect(ok.marks.map((m) => `${m.id}:${m.points.length}`)).toEqual(['session-old:3']);
    expect(loadPendingSessions()).toEqual([]);
    expect(storage.has(PENDING_SESSIONS_KEY)).toBe(false);
    // Nothing left: a plain boot is a no-op.
    expect(await saveUnfinishedSession(ok)).toBeNull();
    expect(ok.marks).toHaveLength(1);
  });

  it('start() over a session boot never tried to save (the mock-grid fallback) puts it aside; resuming the same session does not', async () => {
    storage.set(SESSION_KEY, JSON.stringify(session('session-left', 4)));
    const g = grid();
    const recorder = new Recorder(g, location, events);
    await recorder.start();
    expect(loadUnfinishedSession()?.id).not.toBe('session-left');
    expect(loadPendingSessions().map((s) => `${s.id}:${s.points.length}`)).toEqual(['session-left:4']);
    recorder.discard();
    // Resuming the very session that is in the slot is not an overwrite.
    const same = session('session-same', 2);
    storage.set(SESSION_KEY, JSON.stringify(same));
    const r2 = new Recorder(g, location, events);
    await r2.start(same);
    expect(loadUnfinishedSession()?.id).toBe('session-same');
    expect(loadPendingSessions().map((s) => s.id)).toEqual(['session-left']);
    r2.discard();
  });

  it('stop(): a failed final markTrack keeps the session for the next boot; a working one clears everything', async () => {
    let failing = true;
    const g = grid(() => failing);
    const recorder = new Recorder(g, location, events);
    const s = session('session-stop', 5);
    await recorder.start(s);
    const res = await recorder.stop();
    expect(res?.track.id).toBe('session-stop');
    expect(loadUnfinishedSession()).toBeNull();
    expect(loadPendingSessions().map((x) => `${x.id}:${x.points.length}`)).toEqual(['session-stop:5']);
    failing = false;
    expect((await saveUnfinishedSession(g))?.id).toBe('session-stop');
    expect(g.marks.map((m) => m.id)).toEqual(['session-stop']);
    expect(loadPendingSessions()).toEqual([]);
  });

  it('the pending list drops sessions under 2 points, dedupes by id and keeps the newest MAX_PENDING_SESSIONS', () => {
    stashSession(session('tiny', 1));
    expect(loadPendingSessions()).toEqual([]);
    stashSession(session('a', 2));
    stashSession(session('a', 3)); // the same session again (a kill between stash and remove): one entry, the newer copy
    expect(loadPendingSessions().map((s) => `${s.id}:${s.points.length}`)).toEqual(['a:3']);
    for (let i = 0; i < MAX_PENDING_SESSIONS + 2; i++) stashSession(session(`s${i}`, 2));
    const ids = loadPendingSessions().map((s) => s.id);
    expect(ids).toHaveLength(MAX_PENDING_SESSIONS);
    expect(ids[ids.length - 1]).toBe(`s${MAX_PENDING_SESSIONS + 1}`);
    expect(ids).not.toContain('a'); // the oldest went first
    storage.set(PENDING_SESSIONS_KEY, '{"not":"a list"}');
    expect(loadPendingSessions()).toEqual([]);
  });
});


describe('GPS interruptions leave fog between trail segments', () => {
  it.each(['hidden', 'timeout', 'unavailable', 'poor accuracy', 'silent gap'])(
    '%s preserves the gap through checkpoints, storage, backup and GPX', async (reason) => {
      const doc = new EventTarget() as EventTarget & { visibilityState: string };
      doc.visibilityState = 'visible';
      (globalThis as { document?: unknown }).document = doc;
      let emitFix!: (fix: Fix) => void;
      let emitError!: (error: LocationError) => void;
      const loc = {
        ...location,
        onFix(cb: typeof emitFix) { emitFix = cb; return () => undefined; },
        onError(cb: typeof emitError) { emitError = cb; return () => undefined; },
        retain() {}, release() {},
      } as unknown as LocationManager;
      const g = grid();
      const recorder = new Recorder(g, loc, events);
      await recorder.start();
      const fix = (lon: number, timeMs: number, accuracy = 5) =>
        emitFix({ lon, lat: 40.71, timeMs, accuracy, speed: null, heading: null });
      fix(-73.95, 1000);
      fix(-73.9499, 6000);
      if (reason === 'hidden') {
        doc.visibilityState = 'hidden';
        doc.dispatchEvent(new Event('visibilitychange'));
        doc.visibilityState = 'visible';
        doc.dispatchEvent(new Event('visibilitychange'));
      } else if (reason === 'poor accuracy') fix(-73.949, 11000, 100);
      else if (reason !== 'silent gap') emitError(reason as LocationError);
      const nextTime = reason === 'silent gap' ? 46000 : 16000;
      fix(-73.947, nextTime); // under 500 m: used to reveal the entire missing stretch
      fix(-73.9469, nextTime + 5000);
      const result = await recorder.stop();
      expect(result!.state.breaks).toEqual([2]);
      expect(result!.state.distanceM).toBeLessThan(20);
      const restored = recordToTrack(jsonToTrackRecord(trackRecordToJson(trackToRecord(g.marks[0]))));
      expect(restored.breaks).toEqual([2]);
      expect(trackToRecord(restored).lengthM).toBeLessThan(20);
      const actual = rasterizeTrack(restored.points, { breaks: restored.breaks });
      const joined = rasterizeTrack(restored.points);
      const size = (r: Map<number, Uint32Array>) => [...r.values()].reduce((n, cells) => n + cells.length, 0);
      expect(size(actual)).toBeLessThan(size(joined) / 3);
      expect(trackToGpx(restored).match(/<trkseg>/g)).toHaveLength(2);
    },
  );

  it('continuous fixes keep a connected trail', async () => {
    let emitFix!: (fix: Fix) => void;
    const loc = { ...location, onFix(cb: typeof emitFix) { emitFix = cb; return () => undefined; } } as unknown as LocationManager;
    const recorder = new Recorder(grid(), loc, events);
    await recorder.start();
    for (let i = 0; i < 3; i++) emitFix({ lon: -73.95 + i * 0.0001, lat: 40.71, accuracy: 5, speed: null, heading: null, timeMs: 1000 + i * 5000 });
    const result = await recorder.stop();
    expect(result!.state.breaks).toBeUndefined();
    expect(result!.state.distanceM).toBeGreaterThan(15);
    expect(trackToGpx(result!.track).match(/<trkseg>/g)).toHaveLength(1);
  });
});
