import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouteEngine, loopBBox, routeBBox } from './engine';
import { MapCellLookup } from './cells';
import { graphTilesFor } from './tiles-source';
import { Graph } from './graph';
import { decodeGraphTile, encodeGraphTile } from './graph-format';
import { findLoops } from './loop';
import { findCandidates } from './candidates';
import * as overpass from './overpass';
import { makeLattice } from '../../tests/fixtures/routing/lattice';

const FROM: [number, number] = [-9.2476869, 38.7553241];
const engines: RouteEngine[] = [];
function engine() {
  const e = new RouteEngine({ cells: new MapCellLookup() });
  engines.push(e);
  return e;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const e of engines.splice(0)) {
    for (const d of await e.listDownloads()) await e.deleteDownload(d.id);
    await e.tiles.close();
  }
});

describe('long-loop coverage', () => {
  it('pauses active and queued batches, then allows a fresh download', async () => {
    const e = engine();
    const fetch = vi.spyOn(overpass, 'fetchOverpassWays').mockImplementation((_bbox, opts) => new Promise((_resolve, reject) => {
      const signal = opts!.signal!;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const first = e.downloadLoopArea(FROM, 28);
    const second = e.downloadLoopArea(FROM, 28);
    const rejected = Promise.all([
      expect(first).rejects.toMatchObject({ name: 'AbortError' }),
      expect(second).rejects.toMatchObject({ name: 'AbortError' }),
    ]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await e.cancelAreaDownloads();
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockResolvedValue([]);
    await e.downloadLoopArea(FROM, 28);
    const coverage = await e.coverage(loopBBox(FROM, 28));
    expect(coverage.available).toBe(coverage.needed);
  });

  it.each(['loop', 'route'] as const)('requires every search section even when the partial map can produce a %s', async (kind) => {
    const e = engine();
    const lattice = makeLattice({ size: 31, spacingM: 1000, origin: FROM });
    const from = lattice.at(15, 15), to = lattice.at(20, 15);
    const loopReq = { from, targetKm: 28, mode: 'walk' as const };
    const routeReq = { from, to, detour: 0.25, mode: 'walk' as const };
    const bbox = kind === 'loop' ? loopBBox(from, 28) : routeBBox(from, to);
    const [x, y] = graphTilesFor(bbox)[0];
    const key = `${x}/${y}`, missing = lattice.tiles.get(key)!;
    expect(missing).toBeDefined();
    const partial = new Map(lattice.tiles);
    partial.delete(key);
    await e.tiles.storeArea({ id: 'partial', center: from, radiusKm: 20 }, partial);
    // Prime the graph cache and prove the old behavior could silently return a suggestion.
    const c = await e.graphFor(bbox);
    const candidate = kind === 'loop' ? findLoops(c.graph, e.cells, loopReq) : findCandidates(c.graph, e.cells, routeReq);
    expect(candidate.candidates.length).toBeGreaterThan(0);
    const request = () => kind === 'loop' ? e.loop(loopReq) : e.route(routeReq);
    await expect(request()).rejects.toMatchObject({ name: 'NoCoverageError', missingTiles: 1 });
    // Check offline too, including after a previously complete graph has been cached.
    vi.stubGlobal('navigator', { onLine: false });
    await expect(request()).rejects.toMatchObject({ name: 'NoCoverageError' });
    await e.tiles.storeArea({ id: 'remaining', center: from, radiusKm: 5 }, new Map([[key, missing]]));
    expect((await request()).candidates.length).toBeGreaterThan(0);
    await e.deleteDownload('remaining');
    await expect(request()).rejects.toMatchObject({ name: 'NoCoverageError' });
    if (kind === 'route') expect((await e.directLine(routeReq)).candidates[0].parts?.[0].kind).toBe('straight');
  });

  it('uses at most two concurrent requests, with monotonic progress and no duplicate overlapping batches', async () => {
    const e = engine();
    let active = 0, peak = 0;
    const fetch = vi.spyOn(overpass, 'fetchOverpassWays').mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return [];
    });
    const progress: number[] = [];
    await Promise.all([
      e.downloadLoopArea(FROM, 28, p => progress.push(p.done)),
      e.downloadLoopArea(FROM, 28),
    ]);
    const total = graphTilesFor(loopBBox(FROM, 28)).length;
    expect(peak).toBe(2);
    expect(active).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(total);
    expect(progress.at(-1)).toBe(total);
    expect(progress.every((v, i) => i === 0 || v >= progress[i - 1])).toBe(true);
  });

  it('downloads the full destination search area and reuses it on the next request', async () => {
    const e = engine();
    const to: [number, number] = [FROM[0] + 0.3, FROM[1]];
    const fetch = vi.spyOn(overpass, 'fetchOverpassWays').mockResolvedValue([]);
    await e.downloadRouteArea(FROM, to);
    const coverage = await e.coverage(routeBBox(FROM, to));
    expect(coverage.available).toBe(coverage.needed);
    expect(coverage.needed).toBeGreaterThan(1);
    fetch.mockClear();
    await e.downloadRouteArea(FROM, to);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reuses cached pack sections, but does not trust clipped legacy area tiles', async () => {
    const e = engine();
    const small = makeLattice({ size: 4, spacingM: 100, origin: FROM });
    await e.tiles.storeArea({ id: 'legacy', center: FROM, radiusKm: 1 }, small.tiles);
    const tile = [...small.tiles.values()][0];
    expect(await e.tiles.hasCompleteTile(tile.tx, tile.ty)).toBe(false);
    e.tiles.fallback = { hasTile: async () => true, getTile: async () => null, covers: () => true };
    const fetch = vi.spyOn(overpass, 'fetchOverpassWays').mockResolvedValue([]);
    await e.downloadLoopArea(FROM, 28);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports missing coverage instead of no loop on a small available graph', async () => {
    const e = engine();
    const small = makeLattice({ size: 4, spacingM: 100, origin: FROM });
    await e.tiles.storeArea({ id: 'small', center: FROM, radiusKm: 1 }, small.tiles);
    await expect(e.loop({ from: FROM, targetKm: 28, mode: 'walk' })).rejects.toMatchObject({ name: 'NoCoverageError' });
  });

  it('downloads complete sections, remembers empty sea tiles, and resumes after failure', async () => {
    const e = engine();
    const fetch = vi.spyOn(overpass, 'fetchOverpassWays').mockResolvedValue([]);
    fetch.mockResolvedValueOnce([]).mockImplementationOnce(async () => {
      await vi.waitFor(async () => expect((await e.listDownloads()).length).toBeGreaterThan(0));
      throw Object.assign(new Error('Bad query'), { status: 400 });
    });
    await expect(e.downloadLoopArea(FROM, 28)).rejects.toThrow('Bad query');
    expect((await e.listDownloads()).length).toBeGreaterThan(0);
    const wanted = graphTilesFor(loopBBox(FROM, 28));
    await e.downloadLoopArea(FROM, 28);
    expect(fetch).toHaveBeenCalledTimes(wanted.length + 1);
    const coverage = await e.coverage(loopBBox(FROM, 28));
    expect(coverage.available).toBe(coverage.needed);
    const result = await e.loop({ from: FROM, targetKm: 28, mode: 'walk' });
    expect(result.candidates).toEqual([]); // Complete, empty map is not missing coverage.
    fetch.mockClear();
    await e.downloadLoopArea(FROM, 28);
    expect(fetch).not.toHaveBeenCalled();
    await e.deleteDownload(`loop-tile:${wanted[0].join('/')}`);
    await e.downloadLoopArea(FROM, 28);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([27, 28, 30, 50, 100])('finds a %s km loop on a sufficiently large road network', (targetKm) => {
    const lattice = makeLattice({ size: 21, spacingM: targetKm * 50, origin: FROM });
    const graph = new Graph([...lattice.tiles.values()].map(t => decodeGraphTile(encodeGraphTile(t))));
    const res = findLoops(graph, new MapCellLookup(), { from: lattice.at(10, 10), targetKm, mode: 'walk' });
    expect(res.candidates.length).toBeGreaterThan(0);
    for (const c of res.candidates) {
      expect(c.lengthM).toBeGreaterThanOrEqual(targetKm * 750);
      expect(c.lengthM).toBeLessThanOrEqual(targetKm * 1250);
    }
  });
});
