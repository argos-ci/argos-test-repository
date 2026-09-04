// Standalone port of the base-commit resolution shipped in argos-javascript
// (packages/core/src/ci-environment/services/github-actions.ts +
// packages/core/src/ci-environment/git.ts), instrumented to show exactly which
// guard fires and what git returns at each step.
import { execFile, execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const log = (...args) => console.log(...args);
const section = (title) => log(`\n${"=".repeat(70)}\n${title}\n${"=".repeat(70)}`);
const debug = (...args) => log("  [debug]", ...args);

function sh(cmd) {
  try {
    return { ok: true, out: execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim() };
  } catch (error) {
    return { ok: false, out: "", err: `${error.message}\n${error.stderr ?? ""}` };
  }
}

// ---------------------------------------------------------------------------
// git.ts port
// ---------------------------------------------------------------------------

/** git.ts `head()` */
function head() {
  try {
    return execSync("git rev-parse HEAD").toString().trim();
  } catch {
    return null;
  }
}

function getGitErrorOutput(error) {
  if (!(error instanceof Error)) return "";
  const stderr = "stderr" in error ? String(error.stderr ?? "") : "";
  return `${error.message}\n${stderr}`;
}

function runGitFetch(args) {
  log(`  $ git fetch ${args.join(" ")}`);
  return execFileAsync("git", ["fetch", ...args]);
}

/** git.ts `readCommitParents()` */
function readCommitParents(sha) {
  try {
    const raw = execFileSync("git", ["rev-list", "--parents", "-n", "1", sha, "--"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const [, ...parents] = raw.toString().trim().split(" ");
    debug(`git rev-list --parents -n 1 ${sha} -- => "${raw.toString().trim()}"`);
    return parents;
  } catch (error) {
    debug(`Failed to read the parents of ${sha}`, getGitErrorOutput(error));
    return null;
  }
}

/** git.ts `getCommitParents()` */
async function getCommitParents(sha) {
  const localParents = readCommitParents(sha);
  debug("local parents:", JSON.stringify(localParents));
  if (localParents?.length) {
    debug("parents available locally, no deepening fetch needed");
    return localParents;
  }

  debug("parents hidden locally, deepening with --depth=2");
  try {
    const { stdout, stderr } = await runGitFetch(["--depth=2", "origin", sha]);
    debug("fetch stdout:", JSON.stringify(stdout));
    debug("fetch stderr:", JSON.stringify(stderr));
  } catch (error) {
    debug(`!! FETCH FAILED for ${sha}:`, getGitErrorOutput(error));
    return localParents;
  }

  const after = readCommitParents(sha);
  debug("parents after deepening:", JSON.stringify(after));
  return after;
}

/** git.ts `getMergeBaseCommitSha()` (simplified: no retry/1000-depth loop) */
async function getGitMergeBaseCommitSha({ base, head: headRef }) {
  const argosBaseRef = `argos/${base}`;
  const argosHeadRef = `argos/${headRef}`;
  for (const depth of [200, 400]) {
    try {
      await runGitFetch(["--force", "--update-head-ok", "--depth", String(depth), "origin", `${headRef}:${argosHeadRef}`]);
      await runGitFetch(["--force", "--update-head-ok", "--depth", String(depth), "origin", `${base}:${argosBaseRef}`]);
    } catch (error) {
      debug("merge-base fetch failed:", getGitErrorOutput(error));
      return null;
    }
    const r = sh(`git merge-base ${argosHeadRef} ${argosBaseRef}`);
    if (r.ok && r.out) return r.out;
  }
  return null;
}

// ---------------------------------------------------------------------------
// github-actions.ts port
// ---------------------------------------------------------------------------

function readEventPayload(env) {
  if (!env.GITHUB_EVENT_PATH) return null;
  if (!existsSync(env.GITHUB_EVENT_PATH)) return null;
  return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf-8"));
}

function getPullRequestFromPayload(payload) {
  if ("pull_request" in payload && payload.pull_request) return payload.pull_request;
  if ("workflow_run" in payload && payload.workflow_run && payload.workflow_run.pull_requests[0])
    return payload.workflow_run.pull_requests[0];
  if ("check_run" in payload && payload.check_run && "pull_requests" in payload.check_run && payload.check_run.pull_requests[0])
    return payload.check_run.pull_requests[0];
  return null;
}

/** github-actions.ts `getTestMergeBaseCommitSha()` */
async function getTestMergeBaseCommitSha(input, env) {
  section("getTestMergeBaseCommitSha()");

  log(`GUARD 1 — GITHUB_EVENT_NAME === "pull_request"`);
  log(`  actual: "${env.GITHUB_EVENT_NAME}"`);
  if (env.GITHUB_EVENT_NAME !== "pull_request") {
    log("  ==> BAILED: not a pull_request event");
    return { sha: null, bail: "event-name" };
  }
  log("  ==> passed");

  const payload = readEventPayload(env);
  const pullRequest = payload ? getPullRequestFromPayload(payload) : null;
  log(`\nGUARD 2 — a pull request in the payload`);
  log(`  payload present: ${Boolean(payload)}, pull_request present: ${Boolean(pullRequest)}`);
  if (!pullRequest) {
    log("  ==> BAILED: no pull request in payload");
    return { sha: null, bail: "no-pull-request" };
  }
  log(`  ==> passed (PR #${pullRequest.number})`);
  log(`      pull_request.base.ref  = ${pullRequest.base.ref}`);
  log(`      pull_request.base.sha  = ${pullRequest.base.sha}`);
  log(`      pull_request.head.ref  = ${pullRequest.head.ref}`);
  log(`      pull_request.head.sha  = ${pullRequest.head.sha}`);
  log(`      pull_request.merge_commit_sha = ${pullRequest.merge_commit_sha}`);

  log(`\nGUARD 3 — input.base === pull_request.base.ref`);
  log(`  input.base = "${input.base}" | pull_request.base.ref = "${pullRequest.base.ref}"`);
  if (input.base !== pullRequest.base.ref) {
    log("  ==> BAILED: base branch mismatch");
    return { sha: null, bail: "base-mismatch" };
  }
  log("  ==> passed");

  const sha = env.GITHUB_SHA;
  const localHead = head();
  log(`\nGUARD 4 — git rev-parse HEAD === GITHUB_SHA`);
  log(`  GITHUB_SHA      = ${sha}`);
  log(`  git rev-parse HEAD = ${localHead}`);
  if (!sha || localHead !== sha) {
    log("  ==> BAILED: not running on the checked out commit");
    return { sha: null, bail: "head-mismatch" };
  }
  log("  ==> passed");

  log(`\nGUARD 5 — HEAD has exactly 2 parents and parents[1] === pull_request.head.sha`);
  const parents = await getCommitParents(sha);
  log(`  parents = ${JSON.stringify(parents)}`);
  if (parents?.length !== 2 || parents[1] !== pullRequest.head.sha) {
    log(`  parents.length = ${parents?.length} (want 2)`);
    log(`  parents[1] = ${parents?.[1]}`);
    log(`  pull_request.head.sha = ${pullRequest.head.sha}`);
    log(`  match = ${parents?.[1] === pullRequest.head.sha}`);
    log("  ==> BAILED: not recognised as a test-merge commit");
    return { sha: null, bail: "not-test-merge", parents };
  }
  log("  ==> passed");

  log(`\n  RESOLVED test-merge base = ${parents[0]}`);
  return { sha: parents[0] ?? null, bail: null, parents };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const env = process.env;

  section("ENVIRONMENT");
  for (const k of [
    "GITHUB_EVENT_NAME", "GITHUB_SHA", "GITHUB_REF", "GITHUB_HEAD_REF",
    "GITHUB_BASE_REF", "GITHUB_REPOSITORY", "GITHUB_RUN_ID", "GITHUB_WORKSPACE",
  ]) {
    log(`  ${k} = ${env[k]}`);
  }

  section("GIT STATE (as checked out)");
  log("  git rev-parse HEAD        :", sh("git rev-parse HEAD").out);
  log("  git rev-parse --is-shallow-repository :", sh("git rev-parse --is-shallow-repository").out);
  log("  .git/shallow              :", existsSync(".git/shallow") ? readFileSync(".git/shallow", "utf-8").trim() : "(absent)");
  log("  remote.origin.fetch       :", sh("git config --get-all remote.origin.fetch").out);
  log("  remote.origin.url         :", sh("git config --get remote.origin.url").out);
  log("  http.<...>.extraheader set:", sh("git config --get-regexp 'http\\..*\\.extraheader'").ok);
  log("  git log --oneline -5      :\n" + sh("git log --oneline --graph -5").out.split("\n").map(l => "      " + l).join("\n"));
  log("  git rev-list --parents -n 1 HEAD --:", sh("git rev-list --parents -n 1 HEAD --").out);
  log("  refs present              :\n" + sh("git for-each-ref --format='      %(refname) %(objectname:short)'").out);

  const payload = readEventPayload(env);
  const pullRequest = payload ? getPullRequestFromPayload(payload) : null;

  // upload.ts: base = config.referenceBranch || config.prBaseBranch || defaultBaseBranch
  const base = pullRequest?.base.ref ?? "main";
  const headBranch = env.GITHUB_HEAD_REF ?? "";

  section(`INPUT  { base: "${base}", head: "${headBranch}" }`);

  const testMerge = await getTestMergeBaseCommitSha({ base }, env);

  section("FALLBACK — plain git merge-base (the OLD behaviour)");
  const mergeBase = await getGitMergeBaseCommitSha({ base, head: headBranch });
  log(`  merge-base = ${mergeBase}`);

  const resolved = testMerge.sha ?? mergeBase;

  section("VERDICT");
  log(`  PR head sha            : ${pullRequest?.head.sha}`);
  log(`  PR base.sha (payload)  : ${pullRequest?.base.sha}`);
  log(`  merge base (old)       : ${mergeBase}`);
  log(`  test-merge base (new)  : ${testMerge.sha ?? `null (bail: ${testMerge.bail})`}`);
  log(`  RESOLVED BASE          : ${resolved}`);
  log("");
  if (testMerge.sha) {
    log(`  RESULT=FIX_APPLIED`);
    log(`  BAIL=none`);
  } else {
    log(`  RESULT=FIX_NOT_APPLIED`);
    log(`  BAIL=${testMerge.bail}`);
  }
  log(`  RESOLVED=${resolved}`);
  log(`  MERGEBASE=${mergeBase}`);
  log(`  DIFFERS=${Boolean(testMerge.sha) && testMerge.sha !== mergeBase}`);
}

main().catch((error) => {
  console.error("PROBE CRASHED", error);
  process.exit(1);
});
