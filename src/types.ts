export interface RuntimeTelemetrySample {
  atMs: number;
  cpuPct: number;
  memoryRssMb: number;
  diskReadMb?: number;
  diskWriteMb?: number;
  networkRxMb?: number;
  networkTxMb?: number;
}

export interface RuntimeTelemetry {
  source: "execforge-wrapper";
  wrapperVersion: string;
  captureStartedAt?: string;
  captureFinishedAt?: string;
  /** Exit code of the job — populated from EXECFORGE_JOB_STATUS or EXECFORGE_JOB_EXIT_CODE */
  exitCode?: number;
  /** Raw job.status string from GitHub Actions (success | failure | cancelled) */
  jobStatus?: "success" | "failure" | "cancelled";
  machine?: {
    os?: string;
    arch?: string;
    runnerName?: string;
    runnerEnvironment?: string;
    cpuCount?: number;
    totalMemoryMb?: number;
  };
  samples: RuntimeTelemetrySample[];
  artifacts?: Array<{
    name: string;
    path: string;
    sizeBytes?: number;
    sha256?: string;
  }>;
  annotations?: Array<{
    level: "info" | "warning" | "error";
    message: string;
    source?: string;
  }>;
  tests?: Array<{
    name: string;
    file: string;
    durationSec: number;
    failed: boolean;
    failureMessage?: string;
  }>;
}

export interface RuntimeEnvelope {
  schemaVersion: string;
  collectorVersion: string;
  repositoryFullName: string;
  runId: string;
  runAttempt?: number;
  workflowName?: string;
  branch?: string;
  commitSha?: string;
  telemetry: RuntimeTelemetry;
}
