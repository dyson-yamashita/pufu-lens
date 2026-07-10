import assert from 'node:assert/strict';
import { graphDetailsModalSelection } from './graph-viewer-interactions.ts';

const selection = { id: 'node-1' };

assert.equal(graphDetailsModalSelection(false, selection), undefined);
assert.equal(graphDetailsModalSelection(true, undefined), undefined);
assert.equal(graphDetailsModalSelection(true, selection), selection);

console.log('web graph viewer interaction tests passed');
