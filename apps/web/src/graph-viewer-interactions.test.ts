import assert from 'node:assert/strict';
import {
  clampFloatingPanelPosition,
  defaultFloatingPanelPosition,
  graphDetailsModalSelection,
} from './graph-viewer-interactions.ts';

const selection = { id: 'node-1' };

assert.equal(graphDetailsModalSelection(false, selection), undefined);
assert.equal(graphDetailsModalSelection(true, undefined), undefined);
assert.equal(graphDetailsModalSelection(true, selection), selection);

assert.deepEqual(
  clampFloatingPanelPosition(
    { x: 0, y: 0 },
    {
      panelHeight: 120,
      panelWidth: 200,
      wrapperHeight: 400,
      wrapperWidth: 600,
    },
  ),
  { x: 8, y: 8 },
);

assert.deepEqual(
  clampFloatingPanelPosition(
    { x: 500, y: 400 },
    {
      panelHeight: 120,
      panelWidth: 200,
      wrapperHeight: 400,
      wrapperWidth: 600,
    },
  ),
  { x: 392, y: 272 },
);

assert.deepEqual(
  defaultFloatingPanelPosition({
    panelHeight: 120,
    panelWidth: 200,
    wrapperHeight: 400,
    wrapperWidth: 600,
  }),
  { x: 384, y: 16 },
);

assert.deepEqual(
  clampFloatingPanelPosition(
    { x: 12, y: 20 },
    {
      panelHeight: 360,
      panelWidth: 320,
      wrapperHeight: 360,
      wrapperWidth: 320,
    },
  ),
  { x: 8, y: 8 },
);

console.log('web graph viewer interaction tests passed');
