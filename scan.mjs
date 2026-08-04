/**
 * a11y-gate-action scanner.
 *
 * Launches Chromium via Playwright, runs axe-core WCAG 2.1 A/AA scans over
 * every (page × viewport) combination, and fails the step when violations at
 * or above the configured impact threshold exist.
 *
 * Honest scope: axe automates only a fraction of WCAG checks. A green run
 * blocks a class of regressions on the scanned pages — it is not evidence of
 * accessibility or conformance.
 */
import { chromium } from "playwright";
import http from "node:http";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { appendFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve("axe-core/axe.min.js");

const IMPACT_RANK = { minor: 0, moderate: 1, serious: 2, critical: 3 };

const cfg = {
  url: (process.env.A11Y_URL ?? "").trim(),
  serveDir: (process.env.A11Y_SERVE_DIR ?? "").trim(),
  port: Number(process.env.A11Y_PORT ?? 8901),
  pages: (process.env.A11Y_PAGES ?? "/").split(/\s+/).filter(Boolean),
  viewports: (process.env.A11Y_VIEWPORTS ?? "320x568 768x1024 1280x800 3840x2160")
    .split(/\s+/)
    .filter(Boolean)
    .map((v) => {
      const m = v.match(/^(\d+)x(\d+)$/);
      if (!m) throw new Error(`Bad viewport "${v}" — expected WIDTHxHEIGHT`);
      return { width: Number(m[1]), height: Number(m[2]) };
    }),
  failOn: (process.env.A11Y_FAIL_ON ?? "serious").trim().toLowerCase(),
  exclude: (process.env.A11Y_EXCLUDE ?? "").split(/\s+/).filter(Boolean),
  workspace: process.env.A11Y_WORKSPACE ?? process.cwd(),
};

if (!(cfg.failOn in IMPACT_RANK)) {
  console.error(`fail-on must be one of: ${Object.keys(IMPACT_RANK).join(", ")}`);
  process.exit(1);
}
if (!cfg.url && !cfg.serveDir) {
  console.error("Provide either `url` (running site) or `serve-dir` (static directory).");
  process.exit(1);
}
if (cfg.url && cfg.serveDir) {
  console.error("`url` and `serve-dir` are mutually exclusive.");
  process.exit(1);
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg",
  ".vtt": "text/vtt", ".txt": "text/plain; charset=utf-8",
};

let server = null;
let baseUrl = cfg.url.replace(/\/$/, "");

if (cfg.serveDir) {
  const root = path.resolve(cfg.workspace, cfg.serveDir);
  const stat = await fs.stat(root).catch(() => null);
  if (!stat?.isDirectory()) {
    console.error(`serve-dir does not exist or is not a directory: ${root}`);
    process.exit(1);
  }
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://localhost:${cfg.port}`);
      let filePath = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
      if (!filePath.startsWith(root)) return void res.writeHead(403).end();
      let st = await fs.stat(filePath).catch(() => null);
      if (st?.isDirectory()) {
        filePath = path.join(filePath, "index.html");
        st = await fs.stat(filePath).catch(() => null);
      }
      if (!st) return void res.writeHead(404).end("Not found");
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": st.size,
      });
      createReadStream(filePath).pipe(res);
    } catch (e) {
      res.writeHead(500).end(String(e));
    }
  });
  await new Promise((resolve) => server.listen(cfg.port, resolve));
  baseUrl = `http://localhost:${cfg.port}`;
  console.log(`Serving ${root} at ${baseUrl}`);
}

const axeSource = await fs.readFile(AXE_PATH, "utf8");
const browser = await chromium.launch();
const report = { config: { ...cfg, workspace: undefined }, results: [] };
let total = 0;
let failing = 0;

for (const viewport of cfg.viewports) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  for (const pagePath of cfg.pages) {
    const target = baseUrl + (pagePath.startsWith("/") ? pagePath : `/${pagePath}`);
    const label = `${pagePath} @ ${viewport.width}x${viewport.height}`;
    try {
      const resp = await page.goto(target, { waitUntil: "load", timeout: 60_000 });
      if (!resp || !resp.ok()) {
        console.error(`::error::${label} — HTTP ${resp ? resp.status() : "no response"}`);
        failing++; // an unscannable page fails the gate; silence is not success
        report.results.push({ page: pagePath, viewport, error: `HTTP ${resp?.status()}` });
        continue;
      }
      await page.evaluate(axeSource);
      const results = await page.evaluate(
        ([excludeSelectors]) => {
          const context = excludeSelectors.length
            ? { exclude: excludeSelectors.map((s) => [s]) }
            : document;
          return window.axe.run(context, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
          });
        },
        [cfg.exclude],
      );
      const violations = results.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        helpUrl: v.helpUrl,
        nodes: v.nodes.length,
      }));
      total += violations.length;
      for (const v of violations) {
        const isFailing = IMPACT_RANK[v.impact ?? "minor"] >= IMPACT_RANK[cfg.failOn];
        if (isFailing) failing++;
        const line = `${label} — ${v.id} (${v.impact}): ${v.nodes} node(s) — ${v.help}`;
        console.log(isFailing ? `::error::${line}` : `::warning::${line}`);
      }
      if (violations.length === 0) console.log(`ok: ${label}`);
      report.results.push({ page: pagePath, viewport, violations });
    } catch (err) {
      console.error(`::error::${label} — scan failed: ${err.message}`);
      failing++;
      report.results.push({ page: pagePath, viewport, error: String(err.message) });
    }
  }
  await context.close();
}

await browser.close();
if (server) server.close();

const reportPath = path.join(cfg.workspace, "a11y-gate-report.json");
await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `total-violations=${total}\nfailing-violations=${failing}\nreport-path=${reportPath}\n`,
  );
}

console.log(
  `\nSummary: ${total} violation(s) total, ${failing} at/above "${cfg.failOn}" ` +
    `across ${cfg.pages.length} page(s) x ${cfg.viewports.length} viewport(s). Report: ${reportPath}`,
);
console.log(
  "Reminder: automated checks cover only a fraction of WCAG. A green gate blocks regressions; it is not a conformance claim.",
);

process.exit(failing > 0 ? 1 : 0);
