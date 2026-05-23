import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { cpus, platform, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { COLLECTOR_VERSION, SCHEMA_VERSION } from "./config.js";
const STATE_DIR = ".execforge";
const STATE_FILE = "runtime-state.json";
const TELEMETRY_FILE = "runtime-telemetry.json";
const ENVELOPE_FILE = "runtime-envelope.json";
const LOG_PREFIX = "[ExecForge]";
function statePath(config, file) {
    return join(config.workspace, STATE_DIR, file);
}
function memoryRssMb() {
    return Math.round(process.memoryUsage().rss / 1024 / 1024);
}
function cpuPct() {
    const cpuList = cpus();
    const load = cpuList.reduce((sum, cpu) => {
        const total = Object.values(cpu.times).reduce((inner, v) => inner + v, 0);
        return sum + (total > 0 ? 1 - cpu.times.idle / total : 0);
    }, 0);
    return Number(Math.max(0, Math.min(100, (load / Math.max(1, cpuList.length)) * 100)).toFixed(2));
}
function sample() {
    return {
        atMs: Date.now(),
        cpuPct: cpuPct(),
        memoryRssMb: memoryRssMb(),
    };
}
/** Take `count` samples spaced `delayMs` apart — gives a meaningful burst at start/finish. */
async function burstSample(count = 3, delayMs = 400) {
    const samples = [];
    for (let i = 0; i < count; i++) {
        samples.push(sample());
        if (i < count - 1) {
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
    return samples;
}
async function readState(config) {
    return JSON.parse(await readFile(statePath(config, STATE_FILE), "utf8"));
}
async function writeState(config, state) {
    await mkdir(statePath(config, ""), { recursive: true });
    await writeFile(statePath(config, STATE_FILE), JSON.stringify(state, null, 2));
}
export async function startCapture(config) {
    const startSamples = await burstSample(3, 400);
    const state = {
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
    console.log(`${LOG_PREFIX} Runtime v${COLLECTOR_VERSION} · repo: ${process.env.GITHUB_REPOSITORY ?? "local"}\n` +
        `${LOG_PREFIX} Capture started — ${startSamples.length} initial samples taken.\n` +
        `${LOG_PREFIX} Token : ${config.token ? `${config.token.slice(0, 12)}… (set)` : "NOT SET — telemetry will not be posted"}`);
    return state;
}
/**
 * Map the GitHub job.status string to an exit code integer.
 * job.status is available as ${{ job.status }} in the workflow.
 */
function jobStatusToExitCode(status) {
    if (!status)
        return 0;
    switch (status.toLowerCase()) {
        case "success": return 0;
        case "failure": return 1;
        case "cancelled": return 2;
        default: return 1;
    }
}
/** Decode the five XML predefined entities. */
function decodeXmlEntities(s) {
    return s
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'");
}
/** Extract a single XML attribute value from a tag string. */
function xmlAttr(tag, name) {
    const re = new RegExp(`\\b${name}="([^"]*)"`, "i");
    const match = tag.match(re);
    if (match)
        return decodeXmlEntities(match[1]);
    const sq = new RegExp(`\\b${name}='([^']*)'`, "i");
    const sqMatch = tag.match(sq);
    return sqMatch ? decodeXmlEntities(sqMatch[1]) : "";
}
/**
 * Strip runner workspace prefix from an absolute file path to get a
 * repo-relative path.  GitHub Actions runners use paths like
 * /home/runner/work/<repo>/<repo>/test/foo.test.js
 */
function toRepoRelativePath(absPath) {
    // /home/runner/work/<repo>/<repo>/... → test/...
    const runnerRe = /^\/home\/runner\/work\/[^/]+\/[^/]+\//;
    const stripped = absPath.replace(runnerRe, "");
    return stripped || absPath;
}
/**
 * Parse a JUnit XML file from disk. Expects well-formed XML — no log-line
 * stripping needed since the file is written directly by the test runner.
 */
export function parseJUnitXmlFile(xmlContent) {
    const tests = [];
    // First, build a map of testsuite names (which contain file paths in Node's reporter).
    // Node's junit reporter wraps each file in a <testsuite name="/abs/path/to/test.js">.
    const suiteFileMap = new Map();
    const suiteRe = /<testsuite\b([^>]*)>/gi;
    let suiteMatch;
    while ((suiteMatch = suiteRe.exec(xmlContent)) !== null) {
        const suiteName = xmlAttr(suiteMatch[1], "name");
        if (suiteName) {
            suiteFileMap.set(suiteMatch.index, toRepoRelativePath(suiteName));
        }
    }
    // Sort suite positions so we can find which suite a testcase belongs to.
    const suitePositions = [...suiteFileMap.entries()].sort((a, b) => a[0] - b[0]);
    function findSuiteFile(testcaseIndex) {
        let result = "";
        for (const [pos, file] of suitePositions) {
            if (pos <= testcaseIndex)
                result = file;
            else
                break;
        }
        return result;
    }
    // Match both self-closing <testcase .../> and element <testcase ...>...</testcase>
    const testcaseRe = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gi;
    let match;
    while ((match = testcaseRe.exec(xmlContent)) !== null) {
        const attrs = match[1];
        const body = match[2] ?? "";
        const name = xmlAttr(attrs, "name");
        if (!name)
            continue;
        // Resolution order: explicit file attr → testsuite name → classname → "unknown"
        const rawFile = xmlAttr(attrs, "file");
        const rawClassname = xmlAttr(attrs, "classname");
        const suiteFile = findSuiteFile(match.index);
        let file;
        if (rawFile) {
            file = toRepoRelativePath(rawFile);
        }
        else if (suiteFile && suiteFile !== "test" && suiteFile !== "tests") {
            file = suiteFile;
        }
        else if (rawClassname && rawClassname !== "test" && rawClassname !== "tests") {
            file = toRepoRelativePath(rawClassname);
        }
        else {
            file = suiteFile || rawClassname || "unknown";
        }
        const time = parseFloat(xmlAttr(attrs, "time") || "0");
        const durationSec = Number.isFinite(time) ? time : 0;
        const hasFailure = /<failure\b/i.test(body);
        const hasError = /<error\b/i.test(body);
        const failed = hasFailure || hasError;
        tests.push({
            name,
            file,
            durationSec,
            failed,
            failureMessage: failed ? extractFailureMessage(body) : undefined,
        });
    }
    return tests;
}
/** Pull failure text from JUnit message attribute or element body (Node test runner uses both). */
function extractFailureMessage(body) {
    const block = body.match(/<(?:failure|error)\b([^>]*)>([\s\S]*?)<\/(?:failure|error)>/i);
    if (block) {
        const attrMsg = xmlAttr(block[1], "message");
        if (attrMsg)
            return decodeXmlEntities(attrMsg).trim();
        const inner = decodeXmlEntities(block[2]).replace(/\s+/g, " ").trim();
        if (inner)
            return inner.slice(0, 2000);
    }
    const attrOnly = body.match(/<(?:failure|error)\b[^>]*\bmessage="([^"]*)"/i);
    if (attrOnly?.[1])
        return decodeXmlEntities(attrOnly[1]).trim();
    return undefined;
}
function logJUnitSummary(tests, sourcePath, searchedPaths) {
    if (!tests?.length) {
        if (sourcePath) {
            console.warn(`${LOG_PREFIX} JUnit file found but contained no test cases: ${sourcePath}`);
            return;
        }
        console.warn(`${LOG_PREFIX} No JUnit results file found — per-test failure messages will not reach ExecForge AI.\n` +
            `${LOG_PREFIX}   Searched: ${searchedPaths.join(", ")}\n` +
            `${LOG_PREFIX}   Fix: emit junit-results.xml (e.g. node --test --test-reporter=junit --test-reporter-destination=junit-results.xml)\n` +
            `${LOG_PREFIX}   Or set EXECFORGE_JUNIT_PATH to your results file before the finish step.`);
        return;
    }
    const failed = tests.filter((t) => t.failed);
    const passed = tests.length - failed.length;
    const rel = sourcePath ?? "junit";
    console.log(`${LOG_PREFIX} JUnit: ${tests.length} test(s) from ${rel} — ${passed} passed, ${failed.length} failed`);
    for (const t of failed.slice(0, 5)) {
        const msg = t.failureMessage ? ` — ${t.failureMessage.slice(0, 240)}` : "";
        console.log(`${LOG_PREFIX}   ✗ ${t.file} :: ${t.name}${msg}`);
    }
    if (failed.length > 5) {
        console.log(`${LOG_PREFIX}   … and ${failed.length - 5} more failure(s)`);
    }
}
// ─── Capture lifecycle ────────────────────────────────────────────────────────
export async function finishCapture(config, params = {}) {
    const state = existsSync(statePath(config, STATE_FILE))
        ? await readState(config)
        : await startCapture(config);
    // Burst sample at the end to get finish-time resource usage
    const finishSamples = await burstSample(3, 400);
    // Resolve exit code: explicit override > EXECFORGE_JOB_EXIT_CODE env > job.status > 0
    const jobStatusEnv = params.jobStatus ?? process.env.EXECFORGE_JOB_STATUS;
    const resolvedExitCode = params.exitCode ??
        (process.env.EXECFORGE_JOB_EXIT_CODE !== undefined && process.env.EXECFORGE_JOB_EXIT_CODE !== ""
            ? Number(process.env.EXECFORGE_JOB_EXIT_CODE)
            : jobStatusEnv
                ? jobStatusToExitCode(jobStatusEnv)
                : 0);
    const normalizedJobStatus = jobStatusEnv?.toLowerCase() ?? undefined;
    // ── Auto-discover and parse JUnit XML test results ──────────────────────
    const JUNIT_WELL_KNOWN_PATHS = [
        "junit-results.xml",
        "junit.xml",
        "test-results.xml",
        "test-results/junit.xml",
        "test-report.xml",
        "reports/junit.xml",
    ];
    let tests;
    let junitSource;
    const searchPaths = config.junitPath
        ? [config.junitPath]
        : JUNIT_WELL_KNOWN_PATHS.map((p) => resolve(config.workspace, p));
    for (const candidate of searchPaths) {
        if (existsSync(candidate)) {
            try {
                const xml = await readFile(candidate, "utf8");
                tests = parseJUnitXmlFile(xml);
                junitSource = candidate;
                break;
            }
            catch (err) {
                console.warn(`${LOG_PREFIX} Failed to read JUnit XML at ${candidate}:`, err);
            }
        }
    }
    logJUnitSummary(tests, junitSource, searchPaths);
    const telemetry = {
        ...state,
        captureFinishedAt: new Date().toISOString(),
        exitCode: resolvedExitCode,
        jobStatus: normalizedJobStatus,
        samples: [...state.samples, ...finishSamples],
        artifacts: [],
        annotations: resolvedExitCode !== 0
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
export function buildEnvelope(telemetry) {
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
async function postTelemetryOnce(config, envelope) {
    if (!config.token)
        return;
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
            throw new Error(`ExecForge telemetry POST failed with ${response.status}: ${await response.text()}`);
        }
    }
    finally {
        clearTimeout(timer);
    }
}
export async function postTelemetry(config, envelope) {
    await postTelemetryOnce(config, envelope);
}
/**
 * Post telemetry with retry + exponential backoff.
 * Never throws — logs warnings on failure so CI never breaks because of telemetry.
 */
export async function postTelemetryBestEffort(config, envelope) {
    if (!config.apiUrl) {
        console.warn(`${LOG_PREFIX} ⚠  EXECFORGE_API_URL is not set — telemetry captured locally but NOT posted.`);
        return false;
    }
    const target = `${config.apiUrl}/api/ingestion/runtime-telemetry`;
    if (!config.token) {
        console.warn(`${LOG_PREFIX} ⚠  EXECFORGE_API_TOKEN is not set — add it to your repository secrets.\n` +
            `${LOG_PREFIX}    Telemetry saved locally to .execforge/runtime-envelope.json`);
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
        }
        catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            if (attempt < maxAttempts) {
                const backoffMs = 500 * 2 ** (attempt - 1); // 500ms, 1s, 2s …
                console.warn(`${LOG_PREFIX} Attempt ${attempt}/${maxAttempts} failed — retrying in ${backoffMs}ms. ${lastError}`);
                await new Promise((r) => setTimeout(r, backoffMs));
            }
        }
    }
    console.warn(`${LOG_PREFIX} ✗ All ${maxAttempts} POST attempt(s) failed.\n` +
        `${LOG_PREFIX}   URL:   ${target}\n` +
        `${LOG_PREFIX}   Error: ${lastError}\n` +
        `${LOG_PREFIX}   Telemetry saved to .execforge/runtime-envelope.json as fallback.`);
    return false;
}
/** Wrap a shell command: start → run → finish → post in one step (legacy npx path). */
export async function runCapturedCommand(config, command) {
    console.log(`${LOG_PREFIX} Runtime v${COLLECTOR_VERSION} · repo: ${process.env.GITHUB_REPOSITORY ?? "local"}\n` +
        `${LOG_PREFIX} Wrapping command — prefer the start/finish action split for zero overhead.\n` +
        `${LOG_PREFIX} Token : ${config.token ? `${config.token.slice(0, 12)}… (set)` : "NOT SET — telemetry will not be posted"}`);
    const state = await startCapture(config);
    const sampler = setInterval(() => {
        state.samples.push(sample());
    }, Math.max(1, config.sampleIntervalSec) * 1000);
    const child = spawn(command, {
        shell: true,
        stdio: "inherit",
        env: process.env,
    });
    const exitCode = await new Promise((resolve) => {
        child.on("close", (code) => resolve(code ?? 1));
    });
    clearInterval(sampler);
    state.samples.push(sample());
    await writeState(config, state);
    const { envelope } = await finishCapture(config, { exitCode });
    await postTelemetryBestEffort(config, envelope);
    return exitCode;
}
export async function cleanCapture(config) {
    await rm(statePath(config, ""), { recursive: true, force: true });
}
