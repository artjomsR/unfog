import { expect, test } from '@playwright/test';

test('an interrupted journey survives reload and resumes with a disconnected GPS segment', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('unfog.installDismissed', String(Date.now()));
    localStorage.setItem('unfog.trackingOffered', String(Date.now()));
    if (sessionStorage.getItem('recovery-seeded')) return;
    sessionStorage.setItem('recovery-seeded', '1');
    localStorage.setItem('unfog.settings', JSON.stringify({ tracking: true }));
    localStorage.setItem('unfog.session', JSON.stringify({
      id: 'interrupted-journey', startMs: Date.now() - 86400000,
      points: [[-73.958, 40.7176, Date.now() - 60000], [-73.9579, 40.7176, Date.now() - 55000]],
      distanceM: 8, newCells: 2, dropped: 0, lastCheckpointMs: Date.now() - 55000,
    }));
  });
  await page.goto('?mock=1');
  const prompt = page.getByRole('dialog');
  await expect(prompt).toContainText('Resume your journey?');
  await page.reload(); // closed again before choosing: the original remains recoverable
  await expect(prompt).toContainText('Resume your journey?');
  await page.getByRole('button', { name: 'Resume journey', exact: true }).click();
  await expect(prompt).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('unfog.session') ?? 'null');
    return { id: s?.id, breaks: s?.breaks };
  })).toEqual({ id: 'interrupted-journey', breaks: [2] });
  await page.reload();
  await expect(prompt).toContainText('Resume your journey?');
  await page.getByRole('button', { name: 'Save and start new', exact: true }).click();
  await expect(prompt).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('unfog.session') ?? 'null')?.id)).not.toBe('interrupted-journey');
});

for (const kind of ['route', 'loop'] as const) {
  test(`started ${kind} restores the exact selected path and End clears recovery`, async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('unfog.installDismissed', String(Date.now()));
      localStorage.setItem('unfog.trackingOffered', String(Date.now()));
    });
    await page.goto('?mock=1');
    await page.waitForFunction(() => (window as any).__unfog?.ready);
    await page.evaluate((kind) => {
      const app = (window as any).__unfog;
      if (kind === 'loop') app.openLoop([-73.9568, 40.7176]);
      else app.openRoute({ name: 'Recovery destination', lonlat: [-73.95, 40.725], origin: [-73.9568, 40.7176] });
    }, kind);
    await expect(page.locator('.cand').first()).toBeVisible();
    await page.locator('.cand').last().click();
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await expect(page.locator('.follow-bar')).toBeVisible();
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('unfog.activeRoute')!));
    expect(saved.kind).toBe(kind);
    const label = await page.locator('.follow-bar .name').textContent();
    await page.reload();
    await page.getByRole('button', { name: 'Resume journey', exact: true }).click();
    await expect(page.locator('.follow-bar')).toBeVisible();
    await expect(page.locator('.follow-bar .name')).toHaveText(label!);
    await page.waitForFunction(() => (window as any).__unfog?.ready);
    const drawn = await page.evaluate(async () => {
      const src = (window as any).__unfog.ctx.map.map.getSource('unfog-routes');
      return (await src.getData()).features.map((f: any) => f.geometry.coordinates);
    });
    const candidate = saved.result.candidates[saved.selected];
    expect(drawn).toEqual(candidate.parts?.length ? candidate.parts.map((p: any) => p.coords) : [candidate.coords]);
    await page.getByRole('button', { name: 'End', exact: true }).click();
    expect(await page.evaluate(() => localStorage.getItem('unfog.activeRoute'))).toBeNull();
    await page.reload();
    await page.waitForFunction(() => (window as any).__unfog?.ready);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.follow-bar')).toBeHidden();
  });
}
