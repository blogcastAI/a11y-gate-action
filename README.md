# a11y-gate-action

Composite GitHub Action that runs **axe-core WCAG 2.1 A/AA scans across four
viewports (320×568, 768×1024, 1280×800, 3840×2160)** against a running URL or
a static directory, and fails the job when violations at or above a chosen
impact threshold exist.

## What this does NOT do

- **Automated checks catch only a fraction of WCAG failures.** A green run
  means "no violations axe can detect on the pages you listed" — nothing more.
- A green gate **does not make your site accessible or conformant**, and is
  not evidence for any compliance claim (ADA, EAA, Section 508). Never cite
  it in marketing or legal copy.
- It cannot judge whether alt text is useful, reading order makes sense, or
  captions are accurate — only humans (ideally assistive-technology users)
  can.
- It does not test keyboard operability (traps, focus order, visible focus).
  axe cannot see those; they need real e2e specs. The companion
  [a11y-gate-template](https://github.com/blogcastAI/a11y-gate-template)
  includes them.
- **What it IS for:** blocking a class of *regressions* — once green, no PR
  can reintroduce a detectable violation on the scanned pages.

## Usage

Scan a static build output:

```yaml
jobs:
  a11y:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci && npm run build
      - uses: blogcastAI/a11y-gate-action@v0.1.0
        with:
          serve-dir: dist
          pages: |
            /
            /pricing
            /docs
```

Scan an already-running server:

```yaml
      - run: npm run dev &
      - uses: blogcastAI/a11y-gate-action@v0.1.0
        with:
          url: http://localhost:3000
          pages: "/ /signup /settings"
          exclude: "iframe[src*='youtube']"
```

## Inputs

| Input | Default | Purpose |
|---|---|---|
| `url` | — | Base URL of a running site. Mutually exclusive with `serve-dir`. |
| `serve-dir` | — | Static directory to serve and scan (built-in server). |
| `port` | `8901` | Port for the built-in server. |
| `pages` | `/` | Space/newline-separated paths to scan. |
| `viewports` | `320x568 768x1024 1280x800 3840x2160` | `WIDTHxHEIGHT` list. The default is the four-viewport battery: reflow failures appear only at 320px, density/spacing failures only at 4K. |
| `fail-on` | `serious` | Minimum axe impact that fails: `minor`, `moderate`, `serious`, `critical`. Lower-impact findings are reported as warnings. |
| `exclude` | — | CSS selectors excluded from the scan subtree — for third-party content you cannot fix (cross-origin iframes). Excluding your own components to get green defeats the gate. |

## Outputs

| Output | Meaning |
|---|---|
| `total-violations` | All violations found, across every page × viewport. |
| `failing-violations` | Violations at/above `fail-on` (what actually failed the job). |
| `report-path` | JSON report path — upload it with `actions/upload-artifact` if you want it kept. |

Unreachable or erroring pages count as failures — silence is not success.

## Make it block

Add the job to your PR workflow and mark it a **required status check** on
your default branch (Settings → Branches). An advisory report gets scrolled
past; a required check gets fixed in the PR that caused it.

## Provenance

Extracted from the merge-blocking accessibility gate developed for
perks.locker and generalized. Companions:
[a11y-gate-template](https://github.com/blogcastAI/a11y-gate-template)
(full template repo with keyboard e2e) and an upstream contribution to
[Able Player](https://github.com/ableplayer/ableplayer)'s demo pages.

## License

MIT — see [LICENSE](LICENSE).
