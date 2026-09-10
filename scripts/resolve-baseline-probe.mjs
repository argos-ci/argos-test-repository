// Reproduces the whole client-side baseline resolution of `argos upload` for a
// project WITHOUT remote content access (the light GitHub app), using the real
// argos-javascript source.
//
// upload.ts wires resolveBaseline() with the real getMergeBaseCommitSha() and
// listAncestorCommits(); only the /baseline API call is stubbed, so we can see
// the candidate commits the CLI actually offers the server — and what it falls
// back to when nothing is eligible yet.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const bundle = pathToFileURL(
  resolve(process.cwd(), process.env.ARGOS_BUNDLE ?? "bundle.mjs"),
).href;
const {
  getMergeBaseCommitSha,
  listAncestorCommits,
  resolveBaseline,
  PARENT_COMMITS_LIMIT,
} = await import(bundle);

const env = process.env;
const payload =
  env.GITHUB_EVENT_PATH && existsSync(env.GITHUB_EVENT_PATH)
    ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf-8"))
    : null;
const pullRequest = payload?.pull_request ?? null;

const base = pullRequest?.base?.ref ?? "main";
const branch = env.GITHUB_HEAD_REF || "main";

// upload.ts
const listCommits = async (sha, limit) => {
  const ancestors = await listAncestorCommits({ sha, limit: limit - 1 });
  return [sha, ...ancestors];
};

// Every commit list the CLI would send to POST /baseline.
const offered = [];

console.log("=".repeat(70));
console.log("RESOLVE BASELINE PROBE (no remote content access)");
console.log("=".repeat(70));
console.log(`  PARENT_COMMITS_LIMIT : ${PARENT_COMMITS_LIMIT}`);
console.log(`  input                : { base: "${base}", head: "${branch}" }`);
console.log("");

const { referenceCommit, parentCommits } = await resolveBaseline({
  getMergeBase: () => getMergeBaseCommitSha({ base, head: branch }),
  listCommits,
  // Nothing eligible yet: exactly the case where the base branch tip has no
  // finished, approved build — the common one right after a merge into main.
  findBaseline: async (commits) => {
    offered.push(commits);
    return null;
  },
});

console.log("");
console.log(`  POST /baseline calls : ${offered.length}`);
offered.forEach((commits, index) => {
  console.log(`    [${index}] ${commits.length} commit(s): ${commits.join(", ")}`);
});
console.log("");
console.log(`  referenceCommit      : ${referenceCommit}`);
console.log(`  parentCommits        : ${parentCommits ? `${parentCommits.length} commit(s)` : "null"}`);
if (parentCommits) {
  console.log(`                         ${parentCommits.join(", ")}`);
}

// The server drops the first entry of parentCommits and searches the rest, so
// the fork point has to be in there for an unrebased branch to find a baseline.
const forkPoint = env.FORK_POINT;
console.log("");
console.log(`FORK_POINT=${forkPoint}`);
console.log(`REFERENCE_COMMIT=${referenceCommit}`);
console.log(`CANDIDATES=${parentCommits ? parentCommits.length : 0}`);

if (!forkPoint) {
  console.log("FORK_POINT not set, skipping the assertion");
  process.exit(0);
}

const searched = parentCommits ? parentCommits.slice(1) : [];
const found = searched.includes(forkPoint);
console.log(`FORK_POINT_REACHABLE=${found}`);

if (!found) {
  console.error(
    `\nFAIL: the fork point ${forkPoint} is not among the ${searched.length} commit(s)` +
      ` the server will search, so an unrebased branch finds no baseline.`,
  );
  process.exit(1);
}
console.log("\nPASS: the fork point is among the commits the server will search.");
