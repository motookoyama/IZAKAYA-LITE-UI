import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const publicDir = path.join(projectRoot, "public");

function getGitSha() {
  const fallback = "unknown";
  try {
    return (
      process.env.GIT_COMMIT ||
      process.env.GITHUB_SHA ||
      execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim()
    );
  } catch {
    return fallback;
  }
}

function buildPayload() {
  const gitSha = getGitSha();
  const timestamp = new Date().toISOString();
  return {
    build_id: `${gitSha}-${Date.now()}`,
    git_sha: gitSha,
    built_at: timestamp,
  };
}

function main() {
  mkdirSync(publicDir, { recursive: true });
  const payload = buildPayload();
  const target = path.join(publicDir, "version.json");
  writeFileSync(target, JSON.stringify(payload, null, 2));
  console.log(`[version] wrote ${target} (${payload.build_id})`);
}

main();
