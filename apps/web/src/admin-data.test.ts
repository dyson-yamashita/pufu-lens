import assert from 'node:assert/strict';
import { getProject, getSourceTypeCounts, listProjects, listPublicProjects } from './admin-data.ts';

const projects = listProjects();

assert.equal(projects.length, 2);
assert.equal(getProject('sample-a').failedCount, 2);
assert.equal(getProject('sample-b').failedCount, 0);
assert.equal(getProject('sample-a').visibility, 'public');
assert.equal(getProject('sample-b').visibility, 'private');
assert.notDeepEqual(
  getProject('sample-a').dataSources.map((source) => source.id),
  getProject('sample-b').dataSources.map((source) => source.id),
);

const sampleACounts = getSourceTypeCounts(getProject('sample-a'));
assert.equal(sampleACounts.web, 1);
assert.equal(sampleACounts.github, 1);
assert.equal(sampleACounts.drive, 1);
assert.equal(sampleACounts.gmail, 0);

const publicProjects = listPublicProjects();
assert.equal(publicProjects.length, 1);
assert.equal(publicProjects[0]?.slug, 'sample-a');
assert.equal(publicProjects[0]?.reports[0]?.id, 'report-a');

console.log('web admin data tests passed');
