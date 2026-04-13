#!/usr/bin/env node

import { readFileSync } from "fs";

async function checkUrl(url) {
  const headers = { "User-Agent": "Mozilla/5.0 (freedomstore-url-checker)" };
  try {
    const resp = await fetch(url, {
      method: "HEAD",
      headers,
      signal: AbortSignal.timeout(15000),
    });
    if (resp.status === 405) {
      const resp2 = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      return [resp2.status, null];
    }
    return [resp.status, null];
  } catch (e) {
    return [null, e.message];
  }
}

async function report(label, url, errors) {
  const [status, err] = await checkUrl(url);
  if (status && status < 400) {
    console.log(`  OK  ${status}  ${label}: ${url}`);
  } else {
    const tag = status ?? "ERR";
    console.log(` FAIL  ${tag}  ${label}: ${url}`);
    errors.push([label, url, status]);
  }
}

async function main() {
  const data = JSON.parse(readFileSync("altstore-source.json", "utf-8"));
  const errors = [];

  // Top-level fields
  console.log("=== Source ===");
  for (const key of ["iconURL", "website", "headerURL"]) {
    if (data[key]) {
      await report(key, data[key], errors);
    }
  }

  // Per-app fields
  for (const app of data.apps ?? []) {
    const name = app.name ?? "?";
    console.log(`\n=== ${name} ===`);

    if (app.iconURL) {
      await report("iconURL", app.iconURL, errors);
    }

    for (const [i, url] of (app.screenshots ?? []).entries()) {
      await report(`screenshot[${i + 1}]`, url, errors);
    }

    for (const ver of app.versions ?? []) {
      const version = ver.version ?? "?";
      if (ver.downloadURL) {
        const manifest = ver.downloadURL + "manifest.json";
        await report(`${version} downloadURL`, manifest, errors);
      }
    }
  }

  console.log();
  if (errors.length > 0) {
    console.log(`FAILED: ${errors.length} URL(s) had errors:`);
    for (const [label, url, status] of errors) {
      console.log(`  ${status ?? "ERR"}  ${label}: ${url}`);
    }
    process.exit(1);
  } else {
    console.log("All URLs are OK.");
  }
}

main();
