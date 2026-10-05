// Measures the slide-captcha solver against randomized mock Geetest puzzles (see test_geetest_mock.mjs).
// Env: TRIALS (60) CONCURRENCY (4) SEED (1) MAX_TRIES (4) MOCK (JSON overrides) SOLVER_SRC (path)
//      MIN_FIRST (0.9) MIN_FINAL (0.99) PW_EXECUTABLE (chromium path) VERBOSE=1
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { chromium } from 'playwright-core';
import { mockOptions, widgetHtml } from './test_geetest_mock.mjs';

const TRIALS = Number(process.env.TRIALS || 60);
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const SEED = Number(process.env.SEED || 1);
const MAX_TRIES = Number(process.env.MAX_TRIES || 4);
const MIN_FIRST = Number(process.env.MIN_FIRST || 0.9);
const MIN_FINAL = Number(process.env.MIN_FINAL || 0.99);
const overrides = JSON.parse(process.env.MOCK || '{}');

async function captureSolver(path) {
  const source = await readFile(path, 'utf8');
  let captured;
  const chrome = {
    storage: { local: { set: async () => {} } },
    tabs: { get: async () => ({ id: 1, url: 'https://www.gsxt.gov.cn/index.html' }) },
    scripting: { executeScript: async ({ func }) => { captured = func; return [{ result: undefined }]; } }
  };
  const context = vm.createContext({ chrome, URL, setTimeout });
  vm.runInContext(`${source}\nglobalThis.api = { tryAutoSolveCaptcha };`, context);
  await context.api.tryAutoSolveCaptcha(1);
  if (!captured) throw new Error('tryAutoSolveCaptcha did not inject a function');
  return captured.toString();
}

const solverSource = await captureSolver(process.env.SOLVER_SRC || 'chrome_extension/background.js');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PW_EXECUTABLE || chromium.executablePath()
});

async function runTrial(seed) {
  const opts = mockOptions(seed, overrides);
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  try {
    await page.setContent(`<!doctype html><meta charset="utf-8"><body style="margin:0;height:2000px">${widgetHtml(opts)}</body>`);
    await page.evaluate(() => window.__geetest.show());
    await page.waitForFunction(() => window.__geetest.puzzle);
    const firstPuzzle = await page.evaluate(() => window.__geetest.puzzle);
    const tries = [];
    for (let i = 1; i <= MAX_TRIES; i++) {
      const result = await page.evaluate(`(${solverSource})()`).catch(error => ({ status: 'exception', detail: error.message }));
      tries.push(result);
      if (result?.status === 'solved' || result?.status === 'not_found') break;
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(100);
    const truth = await page.evaluate(() => ({ ...window.__geetest, show: undefined }));
    return { seed, opts, tries, truth, pageErrors, firstPuzzle };
  } finally {
    await page.close();
  }
}

const seeds = Array.from({ length: TRIALS }, (_, i) => SEED + i);
const results = [];
const started = Date.now();
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (seeds.length) {
    const seed = seeds.shift();
    const result = await runTrial(seed);
    results.push(result);
    if (process.env.VERBOSE) {
      const { truth } = result;
      console.log(`seed ${seed}: attempts=${truth.attempts} ok=${truth.solved} errs=${JSON.stringify(truth.errors)} statuses=${result.tries.map(t => t?.status).join(',')}`);
    }
  }
}));
await browser.close();

const firstOk = r => r.truth.attempts >= 1 && r.truth.errors.length === 0 && r.truth.successes === 1;
const finalOk = r => r.truth.solved;
const falsePositive = r => r.tries.some(t => t?.status === 'solved') && !r.truth.solved;
const pct = (n, d) => `${(100 * n / d).toFixed(1)}%`;
const total = results.length;
const first = results.filter(firstOk).length;
const final = results.filter(finalOk).length;
const attempts = results.reduce((sum, r) => sum + r.truth.attempts, 0);
console.log(`\nsolver: ${process.env.SOLVER_SRC || 'chrome_extension/background.js'}`);
console.log(`trials ${total} in ${((Date.now() - started) / 1000).toFixed(0)}s | first drag ok ${first}/${total} (${pct(first, total)}) | solved within ${MAX_TRIES} tries ${final}/${total} (${pct(final, total)}) | avg drags ${(attempts / total).toFixed(2)} | false positives ${results.filter(falsePositive).length}`);

const factors = {
  sliceMode: r => r.opts.sliceMode,
  moveMode: r => r.opts.moveMode,
  scale: r => `${r.opts.scale}${r.opts.scale !== 1 ? (r.opts.naiveScale ? ' naive' : ' proper') : ''}`,
  sliceRatio: r => r.opts.sliceRatio,
  dark: r => r.opts.dark,
  stripes: r => r.opts.stripes,
  noise: r => r.opts.noise,
  panelPosition: r => r.opts.panelPosition,
  listenOn: r => r.opts.listenOn
};
for (const [name, key] of Object.entries(factors)) {
  const groups = new Map();
  for (const r of results) {
    const k = String(key(r));
    const g = groups.get(k) || { n: 0, first: 0, final: 0 };
    g.n++; g.first += firstOk(r) ? 1 : 0; g.final += finalOk(r) ? 1 : 0;
    groups.set(k, g);
  }
  console.log(`  ${name.padEnd(13)} ${[...groups].sort().map(([k, g]) => `${k}: ${g.first}/${g.n} first, ${g.final}/${g.n} final`).join(' | ')}`);
}

const failures = results.filter(r => !finalOk(r) || !firstOk(r)).sort((a, b) => a.seed - b.seed);
for (const r of failures.slice(0, Number(process.env.SHOW || 12))) {
  console.log(`\n-- seed ${r.seed} ${finalOk(r) ? '(first drag missed)' : '(NOT SOLVED)'} opts=${JSON.stringify({ ...r.opts, seed: undefined, W: undefined, H: undefined, tol: undefined, hasFullbg: undefined })}`);
  console.log(`   mock: attempts=${r.truth.attempts} errors=${JSON.stringify(r.truth.errors)} last=${JSON.stringify(r.truth.last)} firstPuzzle=${JSON.stringify(r.firstPuzzle)}`);
  console.log(`   solver: ${r.tries.map(t => JSON.stringify(t)).join('\n           ')}`);
  if (r.pageErrors.length) console.log(`   page errors: ${r.pageErrors.join(' | ')}`);
}

if (final / total < MIN_FINAL || first / total < MIN_FIRST || results.some(falsePositive)) {
  console.error(`\nFAIL: need first >= ${MIN_FIRST}, final >= ${MIN_FINAL}, no false positives`);
  process.exitCode = 1;
} else {
  console.log('\ncaptcha solver ok');
}
