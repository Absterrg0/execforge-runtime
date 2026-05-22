import { type RuntimeConfig } from "./config.js";
import type { RuntimeEnvelope, RuntimeTelemetry, RuntimeTelemetrySample } from "./types.js";
interface RuntimeState {
    source: "execforge-wrapper";
    wrapperVersion: string;
    captureStartedAt: string;
    machine: RuntimeTelemetry["machine"];
    samples: RuntimeTelemetrySample[];
}
export declare function startCapture(config: RuntimeConfig): Promise<RuntimeState>;
interface ParsedTest {
    name: string;
    file: string;
    durationSec: number;
    failed: boolean;
    failureMessage?: string;
}
/**
 * Parse a JUnit XML file from disk. Expects well-formed XML — no log-line
 * stripping needed since the file is written directly by the test runner.
 */
export declare function parseJUnitXmlFile(xmlContent: string): ParsedTest[];
export declare function finishCapture(config: RuntimeConfig, params?: {
    exitCode?: number;
    jobStatus?: string;
}): Promise<{
    telemetry: RuntimeTelemetry;
    envelope: RuntimeEnvelope;
}>;
export declare function buildEnvelope(telemetry: RuntimeTelemetry): RuntimeEnvelope;
export declare function postTelemetry(config: RuntimeConfig, envelope: RuntimeEnvelope): Promise<void>;
/**
 * Post telemetry with retry + exponential backoff.
 * Never throws — logs warnings on failure so CI never breaks because of telemetry.
 */
export declare function postTelemetryBestEffort(config: RuntimeConfig, envelope: RuntimeEnvelope): Promise<boolean>;
/** Wrap a shell command: start → run → finish → post in one step (legacy npx path). */
export declare function runCapturedCommand(config: RuntimeConfig, command: string): Promise<number>;
export declare function cleanCapture(config: RuntimeConfig): Promise<void>;
export {};
