// Runs the REAL argos-javascript resolver (bundled from the checked out source
// of argos-ci/argos-javascript) against the real GitHub Actions git context.
//
// `bundle.mjs` is produced by the workflow with esbuild from
// packages/core/src/ci-environment/index.ts, so this exercises the exact code
// that ships in @argos-ci/core — not a re-implementation.
import { existsSync, readFileSync } from "node:fs";

const { getMergeBaseCommitSha, listAncestorCommits } = await import(
  process.env.ARGOS_BUNDLE ?? "./bundle.mjs"
);

const env = process.env;

function readEventPayload() {
  if (!env.GITHUB_EVENT_PATH || !existsSync(env.GITHUB_EVENT_PATH)) {
    return null;
  }
  return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf-8"));
}

const payload = readEventPayload();
const pullRequest = payload?.pull_request ?? null;

// upload.ts: base = config.referenceBranch || config.prBaseBranch || defaultBaseBranch
const base = pullRequest?.base?.ref ?? "main";
// github-actions.ts `getBranch()` resolves to GITHUB_HEAD_REF on a pull request.
const head = env.GITHUB_HEAD_REF || "main";

console.log("=".repeat(70));
console.log("REAL SOURCE PROBE");
console.log("=".repeat(70));
console.log(`  GITHUB_EVENT_NAME      : ${env.GITHUB_EVENT_NAME}`);
console.log(`  GITHUB_SHA             : ${env.GITHUB_SHA}`);
console.log(`  pull_request.head.sha  : ${pullRequest?.head?.sha}`);
console.log(`  pull_request.base.ref  : ${pullRequest?.base?.ref}`);
console.log(`  pull_request.base.sha  : ${pullRequest?.base?.sha}  (payload, may be stale)`);
console.log(`  input                  : { base: "${base}", head: "${head}" }`);
console.log("");

const resolved = await getMergeBaseCommitSha({ base, head });

console.log("");
console.log(`  getMergeBaseCommitSha  : ${resolved}`);

// resolveBaseline() then lists the reference commit followed by its ancestors.
if (resolved) {
  const ancestors = await listAncestorCommits({ sha: resolved, limit: 9 });
  console.log(`  listAncestorCommits    : ${JSON.stringify(ancestors)}`);
}

console.log("");
console.log(`REAL_RESOLVED=${resolved}`);
