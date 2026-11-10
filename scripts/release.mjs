#!/usr/bin/env node
// Creates GitHub Releases from CHANGELOG.md sections.
//
//   node scripts/release.mjs --missing [--dry-run]   backfill every tag without a release
//   node scripts/release.mjs v2.1.0 [--dry-run]      one tag
//
// Title comes from the `## vX.Y.Z — ...` heading, body from the text below it,
// so a release never drifts from the changelog. Releases are created oldest
// first, which leaves GitHub's "Latest" badge on the newest version.
//
// Re-running is safe: a tag that already has a release is skipped, so the same
// command works from a release script and from the tag-push workflow.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');

function sh(cmd, args, input) {
  return execFileSync(cmd, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

/** Returns {title, body} for a tag, or null when the changelog has no section. */
export function notesFor(tag) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## ${tag} `));
  if (start === -1) return null;

  const title = lines[start].slice(3).trim();
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('## ')) end += 1;

  const body = lines
    .slice(start + 1, end)
    .join('\n')
    .replace(/\n*---\s*$/, '')
    .trim();
  return { title, body };
}

function hasRelease(tag) {
  try {
    sh('gh', ['release', 'view', tag, '--json', 'tagName']);
    return true;
  } catch {
    return false;
  }
}

function releasedTags() {
  let json = '[]';
  try {
    json = sh('gh', ['release', 'list', '--limit', '500', '--json', 'tagName']);
  } catch {
    // No releases yet (or gh cannot list them): treat every tag as missing.
  }
  return new Set(JSON.parse(json).map((release) => release.tagName));
}

function allTags() {
  // Ascending semver so the last created release is the newest version.
  return sh('git', ['tag', '--sort=v:refname']).split('\n').filter(Boolean);
}

function createRelease(tag, { dryRun }) {
  const notes = notesFor(tag);
  if (!notes) {
    console.error(`skip ${tag}: no "## ${tag}" section in CHANGELOG.md`);
    return false;
  }
  if (hasRelease(tag)) {
    console.log(`skip ${tag}: release already exists`);
    return true;
  }
  // A suffix such as -beta.1 must not steal the "Latest" badge.
  const flags = tag.includes('-') ? ['--prerelease', '--latest=false'] : [];
  if (dryRun) {
    console.log(`would create ${notes.title}${flags.length ? ' (prerelease)' : ''}\n  ${notes.body.split('\n')[0]} …\n`);
    return true;
  }
  sh('gh', ['release', 'create', tag, ...flags, '--title', notes.title, '--notes-file', '-'], notes.body);
  console.log(`created ${notes.title}`);
  return true;
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const missing = args.includes('--missing');
const tags = args.filter((arg) => !arg.startsWith('--'));

if (missing) {
  const released = releasedTags();
  const todo = allTags().filter((tag) => !released.has(tag));
  if (todo.length === 0) {
    console.log('every tag already has a release');
    process.exit(0);
  }
  console.log(`${todo.length} tag(s) without a release: ${todo.join(' ')}\n`);
  let failed = 0;
  for (const tag of todo) if (!createRelease(tag, { dryRun })) failed += 1;
  process.exit(failed === 0 ? 0 : 1);
}

if (tags.length === 0) {
  console.error('usage: node scripts/release.mjs <tag>... | --missing [--dry-run]');
  process.exit(2);
}

let failed = 0;
for (const tag of tags) if (!createRelease(tag, { dryRun })) failed += 1;
process.exit(failed === 0 ? 0 : 1);
