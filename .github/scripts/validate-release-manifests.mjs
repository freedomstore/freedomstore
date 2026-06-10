#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const COMMENT_MARKER = "<!-- freedomstore-release-manifest-check -->";
const DEFAULT_SOURCE_FILE = "altstore-source.json";
const USER_AGENT = "Mozilla/5.0 (freedomstore-manifest-checker)";

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }

    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = value;
      i += 1;
    }
  }

  return args;
}

function readJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function readJsonFile(filePath, label) {
  return readJson(readFileSync(filePath, "utf8"), label);
}

function readBaseSource({ baseFile, baseRef, sourceFile }) {
  if (baseFile) {
    return readJsonFile(baseFile, baseFile);
  }

  const ref = baseRef ?? "origin/main";
  try {
    const source = execFileSync("git", ["show", `${ref}:${sourceFile}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return readJson(source, `${sourceFile} at ${ref}`);
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`Could not read ${sourceFile} from ${ref}: ${detail}`);
  }
}

function stringValue(value) {
  if (value === undefined || value === null) {
    return undefined;
  }

  return String(value);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function code(value) {
  if (value === undefined) {
    return "`<missing>`";
  }

  return `\`${String(value)}\``;
}

function getMarketplaceId(app) {
  return app?.marketplaceID ?? app?.marketplaceId;
}

function getDownloadUrl(version) {
  return version?.downloadURL ?? version?.downloadUrl;
}

function versionKey(version) {
  return [
    stringValue(version?.version) ?? "",
    stringValue(version?.buildVersion) ?? "",
    stringValue(getDownloadUrl(version)) ?? "",
  ].join("\u0000");
}

function appKey(app, index) {
  return stringValue(app?.bundleIdentifier) ?? `app-index-${index}`;
}

function requireAppsArray(source, label, issues) {
  if (!Array.isArray(source.apps)) {
    issues.push(`${label}: expected \`apps\` to be an array.`);
    return [];
  }

  return source.apps;
}

function findReleaseTargets(baseSource, headSource, issues) {
  const baseApps = requireAppsArray(baseSource, "Base altstore-source.json", issues);
  const headApps = requireAppsArray(headSource, "Current altstore-source.json", issues);
  const baseAppByKey = new Map(baseApps.map((app, index) => [appKey(app, index), app]));
  const targets = [];

  for (const [appIndex, app] of headApps.entries()) {
    if (!isRecord(app)) {
      issues.push(`app[${appIndex}]: expected app entry to be an object.`);
      continue;
    }

    const key = appKey(app, appIndex);
    const baseApp = baseAppByKey.get(key);
    const baseVersions = Array.isArray(baseApp?.versions) ? baseApp.versions : [];
    const baseVersionKeys = new Set(baseVersions.map(versionKey));

    if (!Array.isArray(app.versions)) {
      issues.push(`${describeApp(app, appIndex)}: expected \`versions\` to be an array.`);
      continue;
    }

    for (const [versionIndex, version] of app.versions.entries()) {
      if (!isRecord(version)) {
        issues.push(`${describeApp(app, appIndex)} versions[${versionIndex}]: expected version entry to be an object.`);
        continue;
      }

      if (!baseApp || !baseVersionKeys.has(versionKey(version))) {
        targets.push({
          app,
          appIndex,
          version,
          isNewApp: !baseApp,
        });
      }
    }
  }

  return targets;
}

function describeApp(app, index) {
  return stringValue(app.name) ?? stringValue(app.bundleIdentifier) ?? `app[${index}]`;
}

function describeTarget(target) {
  const appName = describeApp(target.app, target.appIndex);
  const version = stringValue(target.version?.version) ?? "unknown version";
  const buildVersion = stringValue(target.version?.buildVersion);
  return buildVersion ? `${appName} ${version} (${buildVersion})` : `${appName} ${version}`;
}

function buildManifestUrl(downloadUrl) {
  const url = new URL(downloadUrl);
  if (!url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}/`;
  }
  return new URL("manifest.json", url).toString();
}

async function fetchManifest(manifestUrl, timeoutMs) {
  const response = await fetch(manifestUrl, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return readJson(body, manifestUrl);
}

function expectEqual({ actual, context, expected, issues, manifestField, sourceField }) {
  const actualString = stringValue(actual);
  const expectedString = stringValue(expected);

  if (expectedString === undefined) {
    issues.push(`${context}: missing \`${sourceField}\` in altstore-source.json.`);
    return;
  }

  if (actualString === undefined) {
    issues.push(`${context}: manifest is missing \`${manifestField}\`.`);
    return;
  }

  if (actualString !== expectedString) {
    issues.push(
      `${context}: \`${manifestField}\` expected ${code(expectedString)} from \`${sourceField}\`, got ${code(actualString)}.`,
    );
  }
}

async function validateTarget(target, timeoutMs, issues, checked) {
  const context = describeTarget(target);
  const bundleIdentifier = target.app.bundleIdentifier;
  const marketplaceId = getMarketplaceId(target.app);
  const downloadUrl = getDownloadUrl(target.version);
  let manifestUrl;

  if (!downloadUrl) {
    issues.push(`${context}: missing \`downloadURL\` in altstore-source.json.`);
    checked.push({ context, manifestUrl: null });
    return;
  }

  try {
    manifestUrl = buildManifestUrl(downloadUrl);
  } catch (error) {
    issues.push(`${context}: invalid \`downloadURL\` ${code(downloadUrl)}: ${error.message}.`);
    checked.push({ context, manifestUrl: null });
    return;
  }

  checked.push({ context, manifestUrl });

  let manifest;
  try {
    manifest = await fetchManifest(manifestUrl, timeoutMs);
  } catch (error) {
    issues.push(`${context}: ${manifestUrl} is not accessible or is invalid JSON (${error.message}).`);
    return;
  }

  expectEqual({
    actual: manifest.bundleId,
    context,
    expected: bundleIdentifier,
    issues,
    manifestField: "bundleId",
    sourceField: "bundleIdentifier",
  });
  expectEqual({
    actual: manifest.appleItemId,
    context,
    expected: marketplaceId,
    issues,
    manifestField: "appleItemId",
    sourceField: "marketplaceID",
  });
  expectEqual({
    actual: manifest.shortVersionString,
    context,
    expected: target.version?.version,
    issues,
    manifestField: "shortVersionString",
    sourceField: "version",
  });
  expectEqual({
    actual: manifest.bundleVersion,
    context,
    expected: target.version?.buildVersion,
    issues,
    manifestField: "bundleVersion",
    sourceField: "buildVersion",
  });
}

function pluralize(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function buildComment({ checked, issues, sourceFile }) {
  const lines = [
    COMMENT_MARKER,
    "### Freedom Store release manifest check",
    "",
  ];

  if (issues.length === 0) {
    lines.push("Result: passed.");
    lines.push("");
    if (checked.length === 0) {
      lines.push(`No new app versions were introduced in \`${sourceFile}\`, so there was nothing to validate.`);
    } else {
      lines.push(`Validated ${checked.length} new ${pluralize(checked.length, "release")} successfully.`);
    }
  } else {
    lines.push("Result: failed.");
    lines.push("");
    lines.push(`Found ${issues.length} ${pluralize(issues.length, "issue")} while validating release manifests.`);
  }

  if (checked.length > 0) {
    lines.push("");
    lines.push("Checked releases:");
    for (const item of checked) {
      const suffix = item.manifestUrl ? ` - ${item.manifestUrl}` : "";
      lines.push(`- ${item.context}${suffix}`);
    }
  }

  if (issues.length > 0) {
    lines.push("");
    lines.push("Issues:");
    for (const issue of issues) {
      lines.push(`- ${issue}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const sourceFile = args.source ?? DEFAULT_SOURCE_FILE;
  const timeoutMs = Number(args["timeout-ms"] ?? 15000);
  const canFetchManifests = Number.isFinite(timeoutMs) && timeoutMs > 0;
  const issues = [];
  const checked = [];

  if (!canFetchManifests) {
    issues.push(`Invalid timeout: ${code(args["timeout-ms"])}.`);
  }

  let headSource;
  let baseSource;

  try {
    headSource = readJsonFile(sourceFile, sourceFile);
  } catch (error) {
    issues.push(error.message);
  }

  try {
    baseSource = readBaseSource({
      baseFile: args["base-file"],
      baseRef: args["base-ref"],
      sourceFile,
    });
  } catch (error) {
    issues.push(error.message);
  }

  if (headSource && baseSource) {
    const targets = findReleaseTargets(baseSource, headSource, issues);
    if (canFetchManifests) {
      for (const target of targets) {
        await validateTarget(target, timeoutMs, issues, checked);
      }
    }
  }

  const comment = buildComment({ checked, issues, sourceFile });
  if (args["comment-file"]) {
    writeFileSync(args["comment-file"], comment);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, comment);
  }

  console.log(comment);

  if (issues.length > 0) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  const comment = buildComment({
    checked: [],
    issues: [`Unexpected validator error: ${error.stack ?? error.message}`],
    sourceFile: DEFAULT_SOURCE_FILE,
  });

  console.log(comment);
  process.exitCode = 1;
});
