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
