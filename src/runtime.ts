import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { cpus, freemem, platform, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { COLLECTOR_VERSION, SCHEMA_VERSION, type RuntimeConfig } from "./config.js";
import type { RuntimeEnvelope, RuntimeTelemetry, RuntimeTelemetrySample } from "./types.js";

const STATE_DIR = ".execforge";
const STATE_FILE = "runtime-state.json";
const TELEMETRY_FILE = "runtime-telemetry.json";
const ENVELOPE_FILE = "runtime-envelope.json";

const LOG_PREFIX = "[ExecForge]";

interface RuntimeState {
  source: "execforge-wrapper";
  wrapperVersion: string;
  captureStartedAt: string;
  machine: RuntimeTelemetry["machine"];
  samples: RuntimeTelemetrySample[];
}

function statePath(config: RuntimeConfig, file: string): string {
  return join(config.workspace, STATE_DIR, file);
}

function memoryRssMb(): number {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

function cpuPct(): number {
  const cpuList = cpus();
  const load = cpuList.reduce((sum, cpu) => {
    const total = Object.values(cpu.times).reduce((inner, v) => inner + v, 0);
    return sum + (total > 0 ? 1 - cpu.times.idle / total : 0);
  }, 0);
  return Number(
    Math.max(0, Math.min(100, (load / Math.max(1, cpuList.length)) * 100)).toFixed(2),
  );
}

function sample(): RuntimeTelemetrySample {
  return {
    atMs: Date.now(),
    cpuPct: cpuPct(),
    memoryRssMb: memoryRssMb(),
  };
}

/** Take `count` samples spaced `delayMs` apart — gives a meaningful burst at start/finish. */
async function burstSample(count = 3, delayMs = 400): Promise<RuntimeTelemetrySample[]> {
  const samples: RuntimeTelemetrySample[] = [];
  for (let i = 0; i < count; i++) {
    samples.push(sample());
    if (i < count - 1) {
      await new Promise<void>((r) => setTimeout(r, delayMs));
    }
  }
  return samples;
}

async function readState(config: RuntimeConfig): Promise<RuntimeState> {
  return JSON.parse(await readFile(statePath(config, STATE_FILE), "utf8")) as RuntimeState;
}

async function writeState(config: RuntimeConfig, state: RuntimeState): Promise<void> {
  await mkdir(statePath(config, ""), { recursive: true });
  await writeFile(statePath(config, STATE_FILE), JSON.stringify(state, null, 2));
}

export async function startCapture(config: RuntimeConfig): Promise<RuntimeState> {
  const startSamples = await burstSample(3, 400);
  const state: RuntimeState = {
    source: "execforge-wrapper",
    wrapperVersion: COLLECTOR_VERSION,
    captureStartedAt: new Date().toISOString(),
    machine: {
      os: process.env.RUNNER_OS ?? platform(),
      arch: process.env.RUNNER_ARCH ?? process.arch,
      runnerName: process.env.RUNNER_NAME,
      runnerEnvironment: process.env.RUNNER_ENVIRONMENT,
      cpuCount: cpus().length,
      totalMemoryMb: Math.round(totalmem() / 1024 / 1024),
    },
    samples: startSamples,
  };

  await writeState(config, state);
  console.log(
    `${LOG_PREFIX} Runtime v${COLLECTOR_VERSION} · repo: ${process.env.GITHUB_REPOSITORY ?? "local"}\n` +
    `${LOG_PREFIX} Capture started — ${startSamples.length} initial samples taken.\n` +
    `${LOG_PREFIX} Token : ${config.token ? `${config.token.slice(0, 12)}… (set)` : "NOT SET — telemetry will not be posted"}`,
  );
  return state;
}

/**
 * Map the GitHub job.status string to an exit code integer.
 * job.status is available as ${{ job.status }} in the workflow.
 */
function jobStatusToExitCode(status: string | undefined): number {
  if (!status) return 0;
  switch (status.toLowerCase()) {
    case "success":   return 0;
    case "failure":   return 1;
    case "cancelled": return 2;
    default:          return 1;
  }
}

// ─── JUnit XML parser ─────────────────────────────────────────────────────────

interface ParsedTest {
  name: string;
  file: string;
  durationSec: number;
  failed: boolean;
  failureMessage?: string;
}

/** Decode the five XML predefined entities. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/** Extract a single XML attribute value from a tag string. */
function xmlAttr(tag: string, name: string): string {
  const re = new RegExp(`\\b${name}="([^"]*)"`, "i");
  const match = tag.match(re);
  if (match) return decodeXmlEntities(match[1]);
  const sq = new RegExp(`\\b${name}='([^']*)'`, "i");
  const sqMatch = tag.match(sq);
  return sqMatch ? decodeXmlEntities(sqMatch[1]) : "";
}

/**
 * Strip runner workspace prefix from an absolute file path to get a
 * repo-relative path.  GitHub Actions runners use paths like
 * /home/runner/work/<repo>/<repo>/test/foo.test.js
 */
function toRepoRelativePath(absPath: string): string {
  // /home/runner/work/<repo>/<repo>/... → test/...
  const runnerRe = /^\/home\/runner\/work\/[^/]+\/[^/]+\//;
  const stripped = absPath.replace(runnerRe, "");
  return stripped || absPath;
}

/**
 * Parse a JUnit XML file from disk. Expects well-formed XML — no log-line
 * stripping needed since the file is written directly by the test runner.
 */
export function parseJUnitXmlFile(xmlContent: string): ParsedTest[] {
  const tests: ParsedTest[] = [];

  // First, build a map of testsuite names (which contain file paths in Node's reporter).
  // Node's junit reporter wraps each file in a <testsuite name="/abs/path/to/test.js">.
  const suiteFileMap = new Map<number, string>();
  const suiteRe = /<testsuite\b([^>]*)>/gi;
  let suiteMatch: RegExpExecArray | null;
  while ((suiteMatch = suiteRe.exec(xmlContent)) !== null) {
    const suiteName = xmlAttr(suiteMatch[1], "name");
    if (suiteName) {
      suiteFileMap.set(suiteMatch.index, toRepoRelativePath(suiteName));
    }
  }

  // Sort suite positions so we can find which suite a testcase belongs to.
  const suitePositions = [...suiteFileMap.entries()].sort((a, b) => a[0] - b[0]);

  function findSuiteFile(testcaseIndex: number): string {
    let result = "";
    for (const [pos, file] of suitePositions) {
      if (pos <= testcaseIndex) result = file;
      else break;
    }
    return result;
  }

  // Match both self-closing <testcase .../> and element <testcase ...>...</testcase>
  const testcaseRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gi;
  let match: RegExpExecArray | null;

  while ((match = testcaseRe.exec(xmlContent)) !== null) {
    const attrs = match[1];
    const body = match[2] ?? "";

    const name = xmlAttr(attrs, "name");
    if (!name) continue;

    // Resolution order: explicit file attr → testsuite name → classname → "unknown"
    const rawFile = xmlAttr(attrs, "file");
    const rawClassname = xmlAttr(attrs, "classname");
    const suiteFile = findSuiteFile(match.index);

    let file: string;
    if (rawFile) {
      file = toRepoRelativePath(rawFile);
    } else if (suiteFile && suiteFile !== "test" && suiteFile !== "tests") {
      file = suiteFile;
    } else if (rawClassname && rawClassname !== "test" && rawClassname !== "tests") {
      file = toRepoRelativePath(rawClassname);
    } else {
      file = suiteFile || rawClassname || "unknown";
    }

    const time = parseFloat(xmlAttr(attrs, "time") || "0");
    const durationSec = Number.isFinite(time) ? time : 0;

    const hasFailure = /<failure\b/i.test(body);
    const hasError = /<error\b/i.test(body);
    const failed = hasFailure || hasError;

    let failureMessage: string | undefined;
    if (failed) {
      const msgMatch = body.match(/<(?:failure|error)\b[^>]*?(?:message="([^"]*)")?[^>]*>/i);
      if (msgMatch?.[1]) {
        failureMessage = decodeXmlEntities(msgMatch[1]);
      }
    }

    tests.push({ name, file, durationSec, failed, failureMessage });
  }

  return tests;
}

// ─── Capture lifecycle ────────────────────────────────────────────────────────

export async function finishCapture(
  config: RuntimeConfig,
  params: {
    exitCode?: number;
    jobStatus?: string;
  } = {},
): Promise<{ telemetry: RuntimeTelemetry; envelope: RuntimeEnvelope }> {
  const state = existsSync(statePath(config, STATE_FILE))
    ? await readState(config)
    : await startCapture(config);

  // Burst sample at the end to get finish-time resource usage
  const finishSamples = await burstSample(3, 400);

  // Resolve exit code: explicit override > EXECFORGE_JOB_EXIT_CODE env > job.status > 0
  const jobStatusEnv = params.jobStatus ?? process.env.EXECFORGE_JOB_STATUS;
  const resolvedExitCode =
    params.exitCode ??
    (process.env.EXECFORGE_JOB_EXIT_CODE !== undefined && process.env.EXECFORGE_JOB_EXIT_CODE !== ""
      ? Number(process.env.EXECFORGE_JOB_EXIT_CODE)
      : jobStatusEnv
      ? jobStatusToExitCode(jobStatusEnv)
      : 0);

  const normalizedJobStatus =
    (jobStatusEnv?.toLowerCase() as RuntimeTelemetry["jobStatus"]) ?? undefined;

  // ── Auto-discover and parse JUnit XML test results ──────────────────────
  const JUNIT_WELL_KNOWN_PATHS = [
    "junit-results.xml",
    "junit.xml",
    "test-results.xml",
    "test-results/junit.xml",
    "test-report.xml",
    "reports/junit.xml",
  ];

  let tests: ParsedTest[] | undefined;
  const searchPaths = config.junitPath
    ? [config.junitPath]
    : JUNIT_WELL_KNOWN_PATHS.map((p) => resolve(config.workspace, p));

  for (const candidate of searchPaths) {
    if (existsSync(candidate)) {
      try {
        const xml = await readFile(candidate, "utf8");
        tests = parseJUnitXmlFile(xml);
        console.log(`${LOG_PREFIX} Parsed ${tests.length} test(s) from ${candidate}`);
        break;
      } catch (err) {
        console.warn(`${LOG_PREFIX} Failed to read JUnit XML at ${candidate}:`, err);
      }
    }
  }

  const telemetry: RuntimeTelemetry = {
    ...state,
    captureFinishedAt: new Date().toISOString(),
    exitCode: resolvedExitCode,
    jobStatus: normalizedJobStatus,
    samples: [...state.samples, ...finishSamples],
    artifacts: [],
    annotations:
      resolvedExitCode !== 0
        ? [
            {
              level: "error",
              message: `Job exited with code ${resolvedExitCode}${normalizedJobStatus ? ` (status: ${normalizedJobStatus})` : ""}`,
              source: "execforge-runtime",
            },
          ]
        : [
            {
              level: "info",
              message: "Job completed successfully.",
              source: "execforge-runtime",
            },
          ],
    tests,
  };

  const envelope = buildEnvelope(telemetry);
  await mkdir(statePath(config, ""), { recursive: true });
  await writeFile(statePath(config, TELEMETRY_FILE), JSON.stringify(telemetry, null, 2));
  await writeFile(statePath(config, ENVELOPE_FILE), JSON.stringify(envelope, null, 2));

  return { telemetry, envelope };
}

export function buildEnvelope(telemetry: RuntimeTelemetry): RuntimeEnvelope {
  const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
  // Use || so an empty GITHUB_RUN_ATTEMPT (seen on some runners) still maps to "1"
  // and matches webhook ingestion keys `${id}:${attempt}`.
  const attempt = process.env.GITHUB_RUN_ATTEMPT || "1";
  return {
    schemaVersion: SCHEMA_VERSION,
    collectorVersion: COLLECTOR_VERSION,
    repositoryFullName: process.env.GITHUB_REPOSITORY ?? "local/repository",
    runId: `${runId}:${attempt}`,
    runAttempt: Number(attempt),
    workflowName: process.env.GITHUB_WORKFLOW,
    branch: process.env.GITHUB_REF_NAME,
    commitSha: process.env.GITHUB_SHA,
    telemetry,
  };
}

/** Single POST attempt with a per-request timeout. */
async function postTelemetryOnce(
  config: RuntimeConfig,
  envelope: RuntimeEnvelope,
): Promise<void> {
  if (!config.token) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(`${config.apiUrl}/api/ingestion/runtime-telemetry`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `runtime:${envelope.repositoryFullName}:${envelope.runId}:${envelope.runAttempt ?? 1}`,
      },
      body: JSON.stringify(envelope),
    });

    if (!response.ok) {
      throw new Error(
        `ExecForge telemetry POST failed with ${response.status}: ${await response.text()}`,
      );
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function postTelemetry(
  config: RuntimeConfig,
  envelope: RuntimeEnvelope,
): Promise<void> {
  await postTelemetryOnce(config, envelope);
}

/**
 * Post telemetry with retry + exponential backoff.
 * Never throws — logs warnings on failure so CI never breaks because of telemetry.
 */
export async function postTelemetryBestEffort(
  config: RuntimeConfig,
  envelope: RuntimeEnvelope,
): Promise<boolean> {
  if (!config.apiUrl) {
    console.warn(
      `${LOG_PREFIX} ⚠  EXECFORGE_API_URL is not set — telemetry captured locally but NOT posted.`,
    );
    return false;
  }

  const target = `${config.apiUrl}/api/ingestion/runtime-telemetry`;

  if (!config.token) {
    console.warn(
      `${LOG_PREFIX} ⚠  EXECFORGE_API_TOKEN is not set — add it to your repository secrets.\n` +
      `${LOG_PREFIX}    Telemetry saved locally to .execforge/runtime-envelope.json`,
    );
    return false;
  }

  console.log(`${LOG_PREFIX} Posting telemetry → ${target}`);

  const maxAttempts = Math.max(1, config.retryCount);
  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await postTelemetryOnce(config, envelope);
      console.log(`${LOG_PREFIX} ✓ Telemetry posted successfully.`);
      return true;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < maxAttempts) {
        const backoffMs = 500 * 2 ** (attempt - 1); // 500ms, 1s, 2s …
        console.warn(
          `${LOG_PREFIX} Attempt ${attempt}/${maxAttempts} failed — retrying in ${backoffMs}ms. ${lastError}`,
        );
        await new Promise<void>((r) => setTimeout(r, backoffMs));
      }
    }
  }

  console.warn(
    `${LOG_PREFIX} ✗ All ${maxAttempts} POST attempt(s) failed.\n` +
    `${LOG_PREFIX}   URL:   ${target}\n` +
    `${LOG_PREFIX}   Error: ${lastError}\n` +
    `${LOG_PREFIX}   Telemetry saved to .execforge/runtime-envelope.json as fallback.`,
  );
  return false;
}

/** Wrap a shell command: start → run → finish → post in one step (legacy npx path). */
export async function runCapturedCommand(
  config: RuntimeConfig,
  command: string,
): Promise<number> {
  console.log(
    `${LOG_PREFIX} Runtime v${COLLECTOR_VERSION} · repo: ${process.env.GITHUB_REPOSITORY ?? "local"}\n` +
    `${LOG_PREFIX} Wrapping command — prefer the start/finish action split for zero overhead.\n` +
    `${LOG_PREFIX} Token : ${config.token ? `${config.token.slice(0, 12)}… (set)` : "NOT SET — telemetry will not be posted"}`,
  );

  const state = await startCapture(config);

  const sampler = setInterval(() => {
    state.samples.push(sample());
  }, Math.max(1, config.sampleIntervalSec) * 1000);

  const child = spawn(command, {
    shell: true,
    stdio: "inherit",
    env: process.env,
  }) as ChildProcessWithoutNullStreams;

  const exitCode = await new Promise<number>((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
  });

  clearInterval(sampler);
  state.samples.push(sample());
  await writeState(config, state);

  const { envelope } = await finishCapture(config, { exitCode });
  await postTelemetryBestEffort(config, envelope);
  return exitCode;
}

export async function cleanCapture(config: RuntimeConfig): Promise<void> {
  await rm(statePath(config, ""), { recursive: true, force: true });
}
