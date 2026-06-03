import assert from 'node:assert/strict';
import { getProject, getSourceTypeCounts, listProjects } from './admin-data.ts';

const projects = listProjects();

assert.equal(projects.length, 2);
assert.equal(getProject('sample-a').failedCount, 2);
assert.equal(getProject('sample-b').failedCount, 0);
assert.notDeepEqual(
  getProject('sample-a').dataSources.map((source) => source.id),
  getProject('sample-b').dataSources.map((source) => source.id),
);

const sampleACounts = getSourceTypeCounts(getProject('sample-a'));
assert.equal(sampleACounts.web, 1);
assert.equal(sampleACounts.github, 1);
assert.equal(sampleACounts.drive, 1);
assert.equal(sampleACounts.gmail, 0);

console.log('web admin data tests passed');
