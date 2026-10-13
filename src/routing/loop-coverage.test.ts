import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouteEngine, loopBBox } from './engine';
import { MapCellLookup } from './cells';
import { graphTilesFor } from './tiles-source';
import { Graph } from './graph';
import { decodeGraphTile, encodeGraphTile } from './graph-format';
import { findLoops } from './loop';
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
  for (const e of engines.splice(0)) {
    for (const d of await e.listDownloads()) await e.deleteDownload(d.id);
    await e.tiles.close();
  }
});

describe('long-loop coverage', () => {
  it('reports missing coverage instead of no loop on a small available graph', async () => {
    const e = engine();
    const small = makeLattice({ size: 4, spacingM: 100, origin: FROM });
    await e.tiles.storeArea({ id: 'small', center: FROM, radiusKm: 1 }, small.tiles);
    await expect(e.loop({ from: FROM, targetKm: 28, mode: 'walk' })).rejects.toMatchObject({ name: 'NoCoverageError' });
  });

  it('downloads complete sections, remembers empty sea tiles, and resumes after failure', async () => {
    const e = engine();
    const fetch = vi.spyOn(overpass, 'fetchOverpassWays').mockResolvedValue([]);
    fetch.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('connection lost'));
    await expect(e.downloadLoopArea(FROM, 28)).rejects.toThrow('connection lost');
    expect(await e.listDownloads()).toHaveLength(1);
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
