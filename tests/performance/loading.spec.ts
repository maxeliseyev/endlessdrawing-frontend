import { test, expect } from '@playwright/test';
import { appendFileSync } from 'node:fs';

test('fixed backend scene through bounded shaped WebSocket', async ({ browser }, info) => {
  test.setTimeout(600_000);
  const runs = Number(process.env.BENCH_RUNS ?? 5);
  const zooms = (process.env.BENCH_ZOOMS ?? '1').split(',').map(Number);
  const dprs = (process.env.BENCH_DPRS ?? '1').split(',').map(Number);
  for (const zoom of zooms) for (const dpr of dprs) for (let run = 0; run < runs; run++) {
    const context = await browser.newContext({ viewport: { width: 1000, height: 700 }, deviceScaleFactor: dpr });
    const page = await context.newPage();
    await page.goto(`/tests/performance/index.html?zoom=${zoom}`);
    await page.waitForFunction(() => 'loadingBench' in window);
    const base = zoom === 1 ? 0 : zoom === 0.16 ? 1000 : 2000;
    const ids = Array.from({ length: 10 }, (_, i) => `00000000-0000-4000-8000-${(base + 301 + i).toString(16).padStart(12, '0')}`);
    for (const scenario of (process.env.BENCH_SCENARIOS ?? 'cold,warm,pan,reconnect,empty').split(',')) {
      const expected = scenario === 'pan' || scenario === 'reconnect' ? ids.map((id, i) => id.slice(0, -12) + (base + 801 + i).toString(16).padStart(12, '0')) : scenario === 'empty' ? [] : ids;
      const result = await page.evaluate(async ({ ids, scenario }) => {
        const bench = (window as unknown as { loadingBench: { run(ids: string[], scenario: string): Promise<Record<string, unknown>> } }).loadingBench;
        return bench.run(ids, scenario);
      }, { ids: expected, scenario });
      expect(result.failures).toEqual([]);
      expect(result.strokes).toBe(scenario === 'pan' || scenario === 'reconnect' ? 610 : scenario === 'empty' ? 0 : 310);
      if (scenario !== 'empty') expect(result.first_paint_ms).not.toBeNull();
      if (scenario === 'warm') expect(result.received_points).toBe(0);
      appendFileSync(process.env.BENCH_OUTPUT!, JSON.stringify({ browser: info.project.name, browser_version: browser.version(), run, ...result }) + '\n');
    }
    await page.close(); await context.close();
  }
});
