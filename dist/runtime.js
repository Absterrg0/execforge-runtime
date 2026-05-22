import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { cpus, platform, totalmem } from "node:os";
import { join } from "node:path";
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
