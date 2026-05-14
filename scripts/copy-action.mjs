import { copyFile, chmod } from "node:fs/promises";

// Copy root action.yml into dist/ (used by the action runner)
await copyFile("action.yml", "dist/action.yml");

// Make CLI executable
await chmod("dist/cli.js", 0o755);

console.log("Build artefacts copied.");
