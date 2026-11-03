#!/usr/bin/env node
// Cuts a ThingMaker release: `pnpm release 0.2.0`.
//
// Sets the version everywhere the build reads it (tauri.conf.json, which the
// updater compares; the Cargo workspace; the two package.json files),
// refreshes Cargo.lock, commits "Release v0.2.0" and tags it v0.2.0. It does
// not push: pushing the tag starts the release workflow, so that step stays
// yours. See docs/release.md.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2]?.replace(/^v/, "");

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail("Usage: pnpm release <version>, for example pnpm release 0.2.0");

const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const confPath = join(root, "apps/desktop/src-tauri/tauri.conf.json");
const conf = JSON.parse(readFileSync(confPath, "utf8"));
const current = conf.version;
const parts = (text) => text.split(/[.-]/).slice(0, 3).map(Number);
const [a, b] = [parts(version), parts(current)];
const newer = a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
if (!newer) fail(`${version} is not newer than the current ${current}.`);
if (git("status", "--porcelain", "--untracked-files=no")) fail("Commit or stash your changes first: a release is cut from a clean tree.");
if (git("tag", "--list", `v${version}`)) fail(`The tag v${version} already exists.`);

/** Replaces the first match, and says so if it is not there. */
function replaceIn(relative, pattern, replacement) {
  const path = join(root, relative);
  const text = readFileSync(path, "utf8");
  if (!pattern.test(text)) fail(`No version found in ${relative}.`);
  writeFileSync(path, text.replace(pattern, replacement));
}

replaceIn("apps/desktop/src-tauri/tauri.conf.json", /"version": "[^"]+"/, `"version": "${version}"`);
replaceIn("Cargo.toml", /(\[workspace\.package\]\nversion = )"[^"]+"/, `$1"${version}"`);
replaceIn("package.json", /"version": "[^"]+"/, `"version": "${version}"`);
replaceIn("apps/desktop/package.json", /"version": "[^"]+"/, `"version": "${version}"`);

// The workspace crates' entries in the lock follow the new version.
execFileSync("cargo", ["update", "--workspace", "--offline"], { cwd: root, stdio: "inherit" });

git("add", "apps/desktop/src-tauri/tauri.conf.json", "Cargo.toml", "Cargo.lock", "package.json", "apps/desktop/package.json");
git("commit", "-m", `Release v${version}`);
git("tag", "-a", `v${version}`, "-m", `ThingMaker v${version}`);

console.log(`\nReleased v${version} locally (was ${current}).`);
console.log("Push the commit and the tag to build it; the workflow leaves a draft release:");
console.log(`  git push origin main && git push origin v${version}`);
console.log("Then publish the draft on GitHub to offer the update to everyone.");
