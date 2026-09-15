const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { test } = require("node:test");
const { findReport, commentOnReport } = require("./comment-release-manifests.cjs");

const marker = "<!-- freedomstore-release-manifest-check -->";

function fixture() {
  const run = {
    id: 123, run_attempt: 2, event: "pull_request", conclusion: "success",
    path: ".github/workflows/validate-release-manifests.yml",
    head_repository: { id: 456, owner: { login: "contributor" } },
    head_branch: "release", head_sha: "abc", pull_requests: [],
  };
  const pr = {
    number: 40, state: "open",
    base: { repo: { full_name: "freedomstore/freedomstore" } },
    head: { repo: { id: 456 }, ref: "release", sha: "abc" },
  };
  const state = {
    prs: [pr], comments: [], calls: [], outputs: {},
    artifacts: [
      { id: 1, name: "release-manifest-report-1", expired: false },
      { id: 2, name: "release-manifest-report-2", expired: false },
    ],
  };
  const github = {
    rest: {
      pulls: { list: "pulls", get: async () => ({ data: pr }) },
      actions: { listWorkflowRunArtifacts: "artifacts" },
      issues: {
        listComments: "comments",
        createComment: async (args) => state.calls.push({ action: "create", ...args }),
        updateComment: async (args) => state.calls.push({ action: "update", ...args }),
      },
    },
    paginate: async (endpoint, args) => {
      assert.equal(args.owner, "freedomstore");
      assert.equal(args.repo, "freedomstore");
      if (endpoint === "pulls") {
        assert.equal(args.head, "contributor:release");
        assert.equal(args.state, "open");
        return state.prs;
      }
      if (endpoint === "artifacts") {
        assert.equal(args.run_id, 123);
        return state.artifacts;
      }
      assert.equal(endpoint, "comments");
      assert.equal(args.issue_number, 40);
      return state.comments;
    },
  };
  return {
    run, pr, state, github,
    context: { repo: { owner: "freedomstore", repo: "freedomstore" }, payload: { workflow_run: run } },
    core: { info() {}, setOutput: (key, value) => { state.outputs[key] = value; } },
    pullRequestNumber: 40,
  };
}

test("resolves a fork PR with no PR metadata and selects only this attempt's artifact", async () => {
  const f = fixture();
  await findReport(f);
  assert.deepEqual(f.state.outputs, { "pull-request": 40, "artifact-id": 2 });
});

for (const [label, change] of [
  ["different fork", (f) => { f.pr.head.repo.id = 789; }],
  ["deleted fork", (f) => { f.pr.head.repo = null; }],
  ["different branch", (f) => { f.pr.head.ref = "other"; }],
  ["new commit", (f) => { f.pr.head.sha = "def"; }],
  ["different base repository", (f) => { f.pr.base.repo.full_name = "other/repo"; }],
  ["closed PR", (f) => { f.pr.state = "closed"; }],
  ["ambiguous PR", (f) => { f.state.prs.push(structuredClone(f.pr)); }],
  ["different workflow", (f) => { f.run.path = ".github/workflows/other.yml"; }],
  ["different event", (f) => { f.run.event = "push"; }],
  ["cancelled run", (f) => { f.run.conclusion = "cancelled"; }],
]) {
  test(`does not target a PR for a ${label}`, async () => {
    const f = fixture();
    change(f);
    await findReport(f);
    assert.deepEqual(f.state.outputs, {});
    assert.deepEqual(f.state.calls, []);
  });
}

test("reports missing artifacts after validation fails", async () => {
  const f = fixture();
  f.run.conclusion = "failure";
  f.state.artifacts[1].expired = true;
  await findReport(f);
  assert.deepEqual(f.state.outputs, { "pull-request": 40 });
  await commentOnReport(f);
  assert.equal(f.state.calls[0].action, "create");
  assert.match(f.state.calls[0].body, /workflow: \*\*failure\*\*/);
  assert.match(f.state.calls[0].body, /did not produce a report/);
  assert.match(f.state.calls[0].body, /runs\/123\/attempts\/2/);
});

for (const conclusion of ["success", "failure"]) {
  test(`posts the ${conclusion} report as text to the verified PR`, async (t) => {
    const f = fixture();
    f.run.conclusion = conclusion;
    const directory = mkdtempSync(join(tmpdir(), "release-comment-test-"));
    t.after(() => rmSync(directory, { recursive: true }));
    f.reportPath = join(directory, "manifest-check-comment.md");
    const report = "PR #999\n${process.exit(1)}\n$(exit 1)\n<script>throw Error()</script>";
    writeFileSync(f.reportPath, `${marker}\n${report}`);
    await findReport(f);
    await commentOnReport(f);
    assert.equal(f.state.calls.length, 1);
    assert.equal(f.state.calls[0].issue_number, 40);
    assert.ok(f.state.calls[0].body.endsWith(report));
    assert.ok(f.state.calls[0].body.includes(`**${conclusion}**`));
  });
}

test("updates its own existing comment without editing another bot's comment", async () => {
  const f = fixture();
  f.state.comments = [
    { id: 11, user: { login: "another[bot]" }, body: marker },
    { id: 12, user: { login: "github-actions[bot]" }, body: marker },
  ];
  await commentOnReport(f);
  assert.equal(f.state.calls[0].action, "update");
  assert.equal(f.state.calls[0].comment_id, 12);
});

test("rechecks the PR commit after downloading the report", async () => {
  const f = fixture();
  await findReport(f);
  f.pr.head.sha = "new-commit";
  await commentOnReport(f);
  assert.deepEqual(f.state.calls, []);
});

test("surfaces a missing downloaded file instead of posting a misleading result", async () => {
  const f = fixture();
  f.reportPath = "/does-not-exist/manifest-check-comment.md";
  await assert.rejects(commentOnReport(f), { code: "ENOENT" });
  assert.deepEqual(f.state.calls, []);
});
