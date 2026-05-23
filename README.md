# ExecForge Runtime SDK

Zero-overhead CI telemetry for GitHub Actions. Captures CPU, memory, duration,
and job outcome and sends it to your [ExecForge](https://execforge.vercel.app) dashboard.

---

## Quick start — recommended pattern

Add the `start` step right after `actions/checkout`, wrap your job, and close
with the `finish` step. The compiled action is cached by GitHub's runner —
**zero download overhead** on every run.

```yaml
steps:
  - uses: actions/checkout@v4

  - uses: Absterrg0/execforge-runtime/start@v1
    env:
      EXECFORGE_API_TOKEN: ${{ secrets.EXECFORGE_API_TOKEN }}

  # ── all your existing workflow steps go here ──────────────────────────────
  - uses: actions/setup-node@v4
    with:
      node-version: "20"
      cache: "npm"
  - run: npm ci && npm test
  # ─────────────────────────────────────────────────────────────────────────

  - uses: Absterrg0/execforge-runtime/finish@v1
    if: always()                            # runs even on failure
    env:
      EXECFORGE_API_TOKEN: ${{ secrets.EXECFORGE_API_TOKEN }}
      EXECFORGE_JOB_STATUS: ${{ job.status }}   # captures real outcome
```

**Why `start`/`finish` instead of `npx`?**
- The action binary is cached by GitHub's runner — **zero download overhead**.
- `npx @execforge/runtime` installs 300+ packages every run (~10 s overhead).
- `EXECFORGE_JOB_STATUS: ${{ job.status }}` gives you the actual success/failure/cancelled outcome.

---

## Full CI example

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: Absterrg0/execforge-runtime/start@v1
        env:
          EXECFORGE_API_TOKEN: ${{ secrets.EXECFORGE_API_TOKEN }}

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Build & test
        run: npm run build && npm test

      - uses: Absterrg0/execforge-runtime/finish@v1
        if: always()
        env:
          EXECFORGE_API_TOKEN: ${{ secrets.EXECFORGE_API_TOKEN }}
          EXECFORGE_JOB_STATUS: ${{ job.status }}
```

---

## Alternative: single-step auto mode

If you want the smallest possible diff to your workflow:

```yaml
- uses: Absterrg0/execforge-runtime@v1
  env:
    EXECFORGE_API_TOKEN: ${{ secrets.EXECFORGE_API_TOKEN }}
    EXECFORGE_JOB_STATUS: ${{ job.status }}
```

This uses GitHub's post-job hook to finish capture after all steps complete.
Add it **once at the top** of your job steps (after `actions/checkout`).

---

## Secrets / environment variables

| Variable | Required | Description |
|---|---|---|
| `EXECFORGE_API_TOKEN` | ✅ | Your ExecForge API token (Settings → API Keys) |
| `EXECFORGE_JOB_STATUS` | Recommended | Pass `${{ job.status }}` to capture real job outcome |
| `EXECFORGE_JUNIT_PATH` | Optional | Path to JUnit XML (default: auto-discover `junit-results.xml`, etc.) |
| `EXECFORGE_API_URL` | Optional | Override the API endpoint (default: `https://execforge.vercel.app`) |
| `EXECFORGE_JOB_EXIT_CODE` | Optional | Numeric exit code override (alternative to `EXECFORGE_JOB_STATUS`) |

---

## CLI usage (local / scripting)

```bash
# Install once in your repo (or use npx)
npm install --save-dev @execforge/runtime

# Start capture
execforge start

# ... run your commands ...

# Finish and post
EXECFORGE_API_TOKEN=your_token execforge finish --exit-code $?
```

---

## What's captured

- **Timing** — job start/finish wall-clock time, total duration
- **CPU** — percentage utilisation (burst-sampled at start + finish)
- **Memory** — RSS in MB (burst-sampled)
- **Job outcome** — success / failure / cancelled
- **Runner info** — OS, arch, runner name, CPU count, total RAM
- **Workflow metadata** — repo, branch, commit SHA, workflow name, run ID
- **Per-test results** — from JUnit XML (name, file, duration, pass/fail, **failure message**)

### JUnit XML (for AI failure analysis)

At **finish**, the SDK auto-discovers `junit-results.xml` (and other well-known paths) or uses `EXECFORGE_JUNIT_PATH`. Failure messages are logged in the Actions console and posted to ExecForge for AI scan / run analysis.

**Node.js built-in test runner:**

```bash
node --test \
  --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=junit --test-reporter-destination=junit-results.xml
```

**Jest:** use `jest-junit` and write `junit-results.xml` (see ExecForge dashboard → Examples).

| Variable | Description |
|---|---|
| `EXECFORGE_JUNIT_PATH` | Override path to your JUnit XML file (repo-relative or absolute) |

---

## Inputs

| Input | Default | Description |
|---|---|---|
| `mode` | `auto` | `auto` · `start` · `finish` · `run` (legacy) |
| `token` | — | Token override (prefer env var) |
| `api-url` | `https://execforge.vercel.app` | API endpoint override |
| `sample-interval-sec` | `5` | Sampling interval for `mode=run` |
| `exit-code` | — | Exit code override for `mode=finish` |

## Outputs

| Output | Description |
|---|---|
| `started` | `"true"` when capture started |
| `posted` | `"true"` when telemetry posted |
