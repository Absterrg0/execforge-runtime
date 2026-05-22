export declare const DEFAULT_API_URL = "https://execforge.vercel.app";
export declare const SCHEMA_VERSION = "2026-05-14";
export declare const COLLECTOR_VERSION = "0.2.0";
export interface RuntimeConfig {
    apiUrl: string;
    token?: string;
    sampleIntervalSec: number;
    workspace: string;
    /** Max POST attempts before giving up (default: 3) */
    retryCount: number;
    /** Per-attempt timeout in ms (default: 10_000) */
    timeoutMs: number;
    /** Path to a JUnit XML results file (default: "junit-results.xml" in workspace) */
    junitPath?: string;
}
export declare function loadRuntimeConfig(overrides?: {
    apiUrl?: string;
    token?: string;
    sampleIntervalSec?: number;
    workspace?: string;
    retryCount?: number;
    timeoutMs?: number;
    junitPath?: string;
}): RuntimeConfig;
