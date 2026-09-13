/**
 * Test: the README Mermaid diagram actually renders.
 *
 * Loads the diagram into a headless browser with the same Mermaid build GitHub
 * uses, so a syntax error is caught here instead of showing a broken box on the
 * repo page. Requires network access (Mermaid is loaded from a CDN).
 *
 * Usage:
 *   node scripts/test-readme-diagram.cjs
 */

const fs = require('fs');
const puppeteer = require('puppeteer');

(async () => {
  const readme = fs.readFileSync('README.md', 'utf8');
  const match = readme.match(/```mermaid\n([\s\S]*?)```/);
  if (!match) throw new Error('No mermaid block found in README.md');
  const diagram = match[1];

  const html = `<!DOCTYPE html><html><body>
    <div id="out"></div>
    <script type="module">
      import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs';
      mermaid.initialize({ startOnLoad: false });
      try {
        const { svg } = await mermaid.render('probe', ${JSON.stringify(diagram)});
        document.getElementById('out').innerHTML = svg;
        window.__ok = true;
      } catch (e) {
        window.__ok = false;
        window.__err = String(e && e.message ? e.message : e);
      }
    </script></body></html>`;

  fs.writeFileSync('/tmp/mermaid-probe.html', html);

  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto('file:///tmp/mermaid-probe.html', { waitUntil: 'networkidle2', timeout: 60000 });
  await page.waitForFunction('window.__ok !== undefined', { timeout: 30000 }).catch(() => {});

  const result = await page.evaluate(() => ({
    ok: window.__ok,
    err: window.__err,
    nodeCount: document.querySelectorAll('#out svg .node').length,
    hasCheckpointer: (document.querySelector('#out svg')?.textContent || '').includes('Checkpointer'),
    hasClarifyLimit: (document.querySelector('#out svg')?.textContent || '').includes('Clarify Limit'),
    hasGuardEdge: (document.querySelector('#out svg')?.textContent || '').includes('after 3 questions in a row'),
    hasStateRestoreEdge: (document.querySelector('#out svg')?.textContent || '').includes('thread state restored'),
    hasUserReplyBox: (document.querySelector('#out svg')?.textContent || '').includes('Language State Machine'),
    hasClarifyAsk: (document.querySelector('#out svg')?.textContent || '').includes('Clarify Ask'),
    hasInterruptNode: (document.querySelector('#out svg')?.textContent || '').includes('suspends the run'),
    hasResumeEdge: (document.querySelector('#out svg')?.textContent || '').includes('resume value'),
  }));

  console.log(JSON.stringify(result, null, 2));
  await browser.close();
  if (!result.ok) process.exit(1);
})().catch((err) => { console.error('FAILED:', err.message); process.exit(1); });
