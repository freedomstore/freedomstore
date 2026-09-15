const { readFileSync } = require("node:fs");

const MARKER = "<!-- freedomstore-release-manifest-check -->";

function matchesRun(pr, run, repository) {
  return pr.state === "open" &&
    pr.base.repo.full_name === repository &&
    pr.head.repo?.id === run.head_repository.id &&
    pr.head.ref === run.head_branch &&
    pr.head.sha === run.head_sha;
}

async function findReport({ github, context, core }) {
  const run = context.payload.workflow_run;
  if (run.event !== "pull_request" ||
      run.path !== ".github/workflows/validate-release-manifests.yml" ||
      !["success", "failure"].includes(run.conclusion)) {
    return;
  }

  const { owner, repo } = context.repo;
  // Fork runs can have an empty pull_requests array, so resolve against GitHub's PR data.
  const prs = await github.paginate(github.rest.pulls.list, {
    owner, repo, state: "open",
    head: `${run.head_repository.owner.login}:${run.head_branch}`,
    per_page: 100,
  });
  const matches = prs.filter((pr) => matchesRun(pr, run, `${owner}/${repo}`));
  if (matches.length !== 1) {
    core.info("No unique open PR matches this run's repository, branch, and commit. Skipping.");
    return;
  }

  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, {
    owner, repo, run_id: run.id, per_page: 100,
  });
  const artifact = artifacts.find((item) =>
    item.name === `release-manifest-report-${run.run_attempt}` && !item.expired);
  core.setOutput("pull-request", matches[0].number);
  if (artifact) core.setOutput("artifact-id", artifact.id);
}

async function commentOnReport({ github, context, core, pullRequestNumber, reportPath }) {
  const { owner, repo } = context.repo;
  const run = context.payload.workflow_run;
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: pullRequestNumber });
  if (!matchesRun(pr, run, `${owner}/${repo}`)) {
    core.info("The PR changed or closed since validation. Skipping the outdated report.");
    return;
  }

  const report = reportPath
    ? readFileSync(reportPath, "utf8").replace(MARKER, "").trim()
    : "The validator did not produce a report. Check the workflow logs.";
  const runUrl = `https://github.com/${owner}/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt}`;
  const body = [
    MARKER,
    `Validation workflow: **${run.conclusion}**. [View run](${runUrl}).`,
    "",
    report.slice(0, 50000),
  ].join("\n");
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner, repo, issue_number: pullRequestNumber, per_page: 100,
  });
  const existingComment = comments.find((comment) =>
    comment.user?.login === "github-actions[bot]" && comment.body?.includes(MARKER));

  if (existingComment) {
    await github.rest.issues.updateComment({ owner, repo, comment_id: existingComment.id, body });
  } else {
    await github.rest.issues.createComment({ owner, repo, issue_number: pullRequestNumber, body });
  }
}

module.exports = { findReport, commentOnReport };
