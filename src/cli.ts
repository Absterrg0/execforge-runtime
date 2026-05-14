#!/usr/bin/env node
import { loadRuntimeConfig } from "./config.js";
import { finishCapture, postTelemetryBestEffort, runCapturedCommand, startCapture } from "./runtime.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function argsAfterDoubleDash(): string | undefined {
  const index = process.argv.indexOf("--");
  if (index === -1) return undefined;
  return process.argv.slice(index + 1).join(" ").trim() || undefined;
}

async function main() {
  const command = process.argv[2];
  const config = loadRuntimeConfig({
    apiUrl: arg("--api-url"),
    token: arg("--token"),
    sampleIntervalSec: arg("--sample-interval-sec")
      ? Number(arg("--sample-interval-sec"))
      : undefined,
  });

  if (command === "start") {
    await startCapture(config);
    console.log("[ExecForge] Capture started.");
    return;
  }

  if (command === "finish") {
    const exitCodeArg = arg("--exit-code");
    const exitCode = exitCodeArg !== undefined ? Number(exitCodeArg) : undefined;
    const { envelope } = await finishCapture(config, { exitCode });
    const posted = await postTelemetryBestEffort(config, envelope);
    if (!posted) process.exitCode = 0; // never break CI due to telemetry failure
    return;
  }

  if (command === "run") {
    const wrapped = argsAfterDoubleDash();
    if (!wrapped) {
      throw new Error(
        "Usage: execforge run -- \"npm test\"\n" +
        "Tip:   prefer  execforge start / execforge finish  to avoid per-run installs.",
      );
    }
    process.exitCode = await runCapturedCommand(config, wrapped);
    return;
  }

  console.log(
    "ExecForge Runtime CLI v" + (await import("./config.js").then(m => m.COLLECTOR_VERSION)) + "\n\n" +
    "Usage:\n" +
    "  execforge start                     Begin capturing telemetry\n" +
    "  execforge finish [--exit-code N]    End capture and post to ExecForge\n" +
    "  execforge run -- \"<command>\"         Capture a single command (legacy)\n\n" +
    "Environment variables:\n" +
    "  EXECFORGE_API_TOKEN      Your API token (required to post)\n" +
    "  EXECFORGE_API_URL        Override API endpoint (default: https://execforge.vercel.app)\n" +
    "  EXECFORGE_JOB_STATUS     Job outcome: success | failure | cancelled\n",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
