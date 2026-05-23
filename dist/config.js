import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
export const DEFAULT_API_URL = "https://execforge.vercel.app";
export const SCHEMA_VERSION = "2026-05-14";
export const COLLECTOR_VERSION = "0.2.1";
function parseDotEnv(path) {
    if (!existsSync(path))
        return {};
    const content = readFileSync(path, "utf8");
    const entries = {};
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#"))
            continue;
        const index = trimmed.indexOf("=");
        if (index === -1)
            continue;
        const key = trimmed.slice(0, index).trim();
        const raw = trimmed.slice(index + 1).trim();
        entries[key] = raw.replace(/^["']|["']$/g, "");
    }
    return entries;
}
export function loadRuntimeConfig(overrides = {}) {
    const workspace = overrides.workspace ?? process.env.GITHUB_WORKSPACE ?? process.cwd();
    const envFile = parseDotEnv(resolve(workspace, ".env"));
    const apiUrl = overrides.apiUrl ??
        process.env.EXECFORGE_API_URL ??
        process.env.EXECFORGE_INGEST_URL ??
        envFile.EXECFORGE_API_URL ??
        envFile.EXECFORGE_INGEST_URL ??
        DEFAULT_API_URL;
    const token = overrides.token ??
        process.env.EXECFORGE_API_TOKEN ??
        process.env.EXECFORGE_INGESTION_TOKEN ??
        envFile.EXECFORGE_API_TOKEN ??
        envFile.EXECFORGE_INGESTION_TOKEN;
    const junitPath = overrides.junitPath ??
        process.env.EXECFORGE_JUNIT_PATH ??
        envFile.EXECFORGE_JUNIT_PATH ??
        undefined;
    return {
        apiUrl: apiUrl.replace(/\/$/, ""),
        token,
        sampleIntervalSec: overrides.sampleIntervalSec ??
            Number(process.env.EXECFORGE_SAMPLE_INTERVAL_SEC ?? envFile.EXECFORGE_SAMPLE_INTERVAL_SEC ?? 5),
        retryCount: overrides.retryCount ?? Number(process.env.EXECFORGE_RETRY_COUNT ?? 3),
        timeoutMs: overrides.timeoutMs ?? Number(process.env.EXECFORGE_TIMEOUT_MS ?? 10_000),
        workspace,
        junitPath: junitPath ? resolve(workspace, junitPath) : undefined,
    };
}
