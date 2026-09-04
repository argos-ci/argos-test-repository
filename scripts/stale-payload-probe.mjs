// Reproduces the "older baseline" symptom: the resolver identifies the
// test-merge commit by comparing its second parent against
// `pull_request.head.sha` taken from the event payload. The payload can be
// stale relative to the merge ref GitHub actually built — this run already
// showed `base.sha` lagging behind the real first parent — and when it is, the
// guard rejects a genuine test-merge commit and silently falls back to the
// merge base, i.e. the fork point.
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const bundle = pathToFileURL(
  resolve(process.cwd(), process.env.ARGOS_BUNDLE ?? "bundle.mjs"),
).href;
const { getMergeBaseCommitSha } = await import(bundle);

const env = process.env;
const realEventPath = env.GITHUB_EVENT_PATH;
if (!realEventPath || !existsSync(realEventPath)) {
  console.log("No event payload, skipping");
  process.exit(0);
}

const payload = JSON.parse(readFileSync(realEventPath, "utf-8"));
const pullRequest = payload.pull_request;
const base = pullRequest.base.ref;
const branch = env.GITHUB_HEAD_REF;

// Any commit that is not the current head of the pull request: it stands in for
// a payload that lags behind the merge ref (a second push landing between the
// event and the merge-ref computation, a re-run, a recomputed merge ref…).
const stale = env.STALE_HEAD_SHA;

console.log("=".repeat(70));
console.log("STALE PAYLOAD PROBE");
console.log("=".repeat(70));
console.log(`  real pull_request.head.sha : ${pullRequest.head.sha}`);
console.log(`  stale pull_request.head.sha: ${stale}`);
console.log("");

const stalePath = resolve(process.cwd(), "stale-event.json");
copyFileSync(realEventPath, stalePath);
const stalePayload = JSON.parse(readFileSync(stalePath, "utf-8"));
stalePayload.pull_request.head.sha = stale;
writeFileSync(stalePath, JSON.stringify(stalePayload));
process.env.GITHUB_EVENT_PATH = stalePath;

const resolved = await getMergeBaseCommitSha({ base, head: branch });

process.env.GITHUB_EVENT_PATH = realEventPath;

console.log("");
console.log(`  resolved with a stale payload : ${resolved}`);
console.log(`  the commit GitHub merged in   : ${env.EXPECTED_BASE}`);
console.log(`  the fork point                : ${env.FORK_POINT}`);
console.log("");
console.log(`STALE_RESOLVED=${resolved}`);

if (resolved === env.FORK_POINT) {
  console.log(
    "\nREPRODUCED: a stale head.sha in the payload sends a genuine test-merge" +
      " build back to the fork point, which is the older baseline.",
  );
} else if (resolved === env.EXPECTED_BASE) {
  console.log("\nNOT REPRODUCED: still resolved to the commit GitHub merged in.");
} else {
  console.log(`\nUNEXPECTED: resolved to ${resolved}.`);
}
