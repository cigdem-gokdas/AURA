import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

const out = '/Users/cigdemgokdas/Desktop/AURA/presentation/.build/dashboard';
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 980 }, deviceScaleFactor: 1 });
  await page.goto('http://127.0.0.1:8787/', { waitUntil: 'networkidle', timeout: 20000 });
  await page.screenshot({ path: path.join(out, 'full.png'), fullPage: true, animations: 'disabled' });
  for (const id of ['markets', 'decision', 'risk', 'mcp', 'position', 'ask']) {
    const section = page.locator(`#${id}`);
    if (await section.count()) await section.screenshot({ path: path.join(out, `${id}.png`), animations: 'disabled' });
  }
  const critic = page.locator('.card.critic');
  if (await critic.count()) await critic.screenshot({ path: path.join(out, 'critic.png'), animations: 'disabled' });
  console.log(JSON.stringify({ title: await page.title(), files: await fs.readdir(out) }));
} finally {
  await browser.close();
}
