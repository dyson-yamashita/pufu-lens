#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';

const TARGET = '    await provisionDefaultComputeServiceAccount(projectId);';
const REPLACEMENT = `    if (process.env.PUFU_LENS_FIREBASE_SKIP_DEFAULT_COMPUTE_SA_PROVISIONING !== "true") {
        await provisionDefaultComputeServiceAccount(projectId);
    }`;

const targetPath = process.argv[2];
if (!targetPath || process.argv.length !== 3) {
  console.error(
    'Usage: patch-apphosting-compute-sa.mjs <firebase-tools-lib-apphosting-backend.js>',
  );
  process.exit(1);
}

const content = readFileSync(targetPath, 'utf8');
const occurrences = content.split(TARGET).length - 1;
if (occurrences !== 1) {
  console.error(
    `Expected exactly one occurrence of the App Hosting compute SA provisioning call, found ${occurrences}.`,
  );
  process.exit(1);
}

writeFileSync(targetPath, content.replace(TARGET, REPLACEMENT), 'utf8');
