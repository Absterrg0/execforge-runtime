import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { EOL } from "node:os";
import { loadRuntimeConfig, type RuntimeConfig } from "./config.js";
import {
  finishCapture,
  postTelemetryBestEffort,
  runCapturedCommand,
  startCapture,
} from "./runtime.js";

// ─── GitHub Actions file-command helpers ──────────────────────────────────────

function input(name: string): string | undefined {
  const key = `INPUT_${name.replace(/ /g, "_").replace(/-/g, "_").toUpperCase()}`;
  const value = process.env[key];
  return value && value.length > 0 ? value : undefined;
}

function toCommandValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function prepareKeyValueMessage(key: string, value: unknown): string {
  const delimiter = `ghadelimiter_${randomUUID()}`;
  const convertedValue = toCommandValue(value);
  if (key.includes(delimiter) || convertedValue.includes(delimiter)) {
    throw new Error("Unexpected delimiter collision in workflow command payload.");
  }
  return `${key}<<${delimiter}${EOL}${convertedValue}${EOL}${delimiter}`;
}

function appendCommandFile(
  envVar: "GITHUB_STATE" | "GITHUB_OUTPUT",
  message: string,
): void {
  const filePath = process.env[envVar];
  if (!filePath || !existsSync(filePath)) return;
  appendFileSync(filePath, `${message}${EOL}`, { encoding: "utf8" });
}

function saveState(name: string, value: unknown): void {
  appendCommandFile("GITHUB_STATE", prepareKeyValueMessage(name, value));
}

function getState(name: string): string {
  const camelSnake = name
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toUpperCase();
  for (const envKey of [`STATE_${name}`, `STATE_${camelSnake}`]) {
    const value = process.env[envKey];
    if (value !== undefined && value !== "") return value;
  }
  return "";
}

function setOutput(name: string, value: unknown): void {
  appendCommandFile("GITHUB_OUTPUT", prepareKeyValueMessage(name, value));
}

// ─── Mode handlers ────────────────────────────────────────────────────────────

async function handleStart(config: RuntimeConfig): Promise<void> {
  await startCapture(config);
  saveState("execforgeMode", "start");
  setOutput("started", "true");
}

async function handleFinish(config: RuntimeConfig, exitCode?: number): Promise<void> {
  // Resolution priority: explicit input > EXECFORGE_JOB_STATUS env > 0
  const resolvedExitCode = exitCode ?? undefined;
  const { envelope } = await finishCapture(config, { exitCode: resolvedExitCode });
  const posted = await postTelemetryBestEffort(config, envelope);
  saveState("execforgeMode", "finish");
  setOutput("posted", posted ? "true" : "false");
}

/**
 * Auto mode: uses GitHub's post-job hook (runs main + post-main via action.yml).
 * The post hook fires after all steps complete, but GitHub does not provide the
 * job exit code. Users should pass it via EXECFORGE_JOB_STATUS=${{ job.status }}
 * on the action env, OR set EXECFORGE_JOB_EXIT_CODE from an earlier step.
 */
async function handleAutoPost(config: RuntimeConfig): Promise<void> {
  // EXECFORGE_JOB_STATUS is set by the user via: env: EXECFORGE_JOB_STATUS: ${{ job.status }}
  // This is the recommended pattern — far more reliable than guessing exit codes.
  const jobStatus = process.env.EXECFORGE_JOB_STATUS;
  if (!jobStatus) {
    console.log(
      "[ExecForge] Tip: add  env: EXECFORGE_JOB_STATUS: ${{ job.status }}  to your action step\n" +
      "[ExecForge] to capture the real job outcome in telemetry.",
    );
  }
  const { envelope } = await finishCapture(config, {});
  const posted = await postTelemetryBestEffort(config, envelope);
  setOutput("posted", posted ? "true" : "false");
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const mode = input("mode") ?? "auto";
  const config = loadRuntimeConfig({
    apiUrl: input("api-url"),
    token: input("token"),
    sampleIntervalSec: input("sample-interval-sec")
      ? Number(input("sample-interval-sec"))
      : undefined,
  });

  const savedMode = getState("execforgeMode");

  // ── Post-job phase (runs via post: dist/action.js in action.yml) ──────────
  if (savedMode !== "") {
    // Post-job runs for mode=auto only; start/finish sub-actions have no post hook.
    if (savedMode === "auto") {
      await handleAutoPost(config);
    }
    return;
  }

  // ── Main phase ────────────────────────────────────────────────────────────
  if (mode === "auto") {
    await startCapture(config);
    saveState("execforgeMode", "auto");
    setOutput("started", "true");
    return;
  }

  if (mode === "start") {
    await handleStart(config);
    return;
  }

  if (mode === "finish") {
    const exitCodeInput = input("exit-code");
    const exitCode = exitCodeInput !== undefined ? Number(exitCodeInput) : undefined;
    await handleFinish(config, exitCode);
    return;
  }

  if (mode === "run") {
    // Legacy mode — still supported but discouraged in favour of start/finish.
    const command = input("command");
    if (!command) {
      throw new Error(
        "The 'command' input is required when mode=run.\n" +
        "Prefer the start/finish sub-actions to instrument the whole job with zero overhead:\n" +
        "  - uses: execforge/runtime/start@v1\n" +
        "    env:\n" +
        "      EXECFORGE_API_TOKEN: ${{ secrets.EXECFORGE_API_TOKEN }}\n" +
        "  # ... your steps ...\n" +
        "  - uses: execforge/runtime/finish@v1\n" +
        "    if: always()\n" +
        "    env:\n" +
        "      EXECFORGE_API_TOKEN: ${{ secrets.EXECFORGE_API_TOKEN }}\n" +
        "      EXECFORGE_JOB_STATUS: ${{ job.status }}\n",
      );
    }
    const exitCode = await runCapturedCommand(config, command);
    saveState("execforgeMode", "run");
    setOutput("exit-code", String(exitCode));
    process.exitCode = exitCode;
    return;
  }

  throw new Error(`Unknown mode '${mode}'. Expected: auto, start, finish, or run.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
