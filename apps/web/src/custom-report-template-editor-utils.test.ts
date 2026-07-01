import assert from 'node:assert/strict';
import {
  CUSTOM_REPORT_LAYOUT_SCHEMA_VERSION,
  validateCustomReportLayout,
} from './custom-report-schema.ts';
import {
  addChildToRow,
  collectPartIds,
  collectResultKeys,
  createDefaultPart,
  layoutToJson,
  moveChildInRow,
  removeChildFromRow,
  replacePartAtPath,
  resetEditorIdCounter,
  updateLayoutRoot,
  updatePartAtPath,
} from './custom-report-template-editor-utils.ts';

resetEditorIdCounter();
const ids = new Set<string>();
const resultKeys = new Set<string>();
const titlePart = createDefaultPart('title', ids, resultKeys);
assert.equal(titlePart.type, 'title');
ids.add(titlePart.id);

const layout = updateLayoutRoot(
  {
    schema_version: CUSTOM_REPORT_LAYOUT_SCHEMA_VERSION,
    root: {
      id: 'root-row',
      type: 'row',
      children: [titlePart],
    },
  },
  {
    id: 'root-row',
    type: 'row',
    children: [titlePart],
  },
);

const sliderPart = createDefaultPart(
  'slider_judgement',
  collectPartIds(layout),
  collectResultKeys(layout),
);
const withSlider = updateLayoutRoot(layout, addChildToRow(layout.root, [], sliderPart));
assert.equal(withSlider.root.type, 'row');
if (withSlider.root.type === 'row') {
  assert.equal(withSlider.root.children.length, 2);
}

const moved = updateLayoutRoot(withSlider, moveChildInRow(withSlider.root, [], 1, -1));
if (moved.root.type === 'row') {
  assert.equal(moved.root.children[0]?.type, 'slider_judgement');
}

const removed = updateLayoutRoot(moved, removeChildFromRow(moved.root, [], 0));
if (removed.root.type === 'row') {
  assert.equal(removed.root.children.length, 1);
  assert.equal(removed.root.children[0]?.type, 'title');
}

const columnsPart = createDefaultPart(
  'columns',
  collectPartIds(removed),
  collectResultKeys(removed),
);
if (columnsPart.type === 'columns') {
  assert.ok(columnsPart.columns.length >= 2);
  assert.ok(columnsPart.columns.length <= 4);
}

const replaced = replacePartAtPath(removed.root, ['children', 0], columnsPart);
if (replaced.type === 'row') {
  assert.equal(replaced.children[0]?.type, 'columns');
}

const json = layoutToJson(removed);
assert.ok(json.includes('schema_version'));
validateCustomReportLayout(JSON.parse(json) as unknown);

assert.throws(
  () => updatePartAtPath(columnsPart, ['columns', 0], (part) => part),
  /Invalid column path/,
);

console.log('custom-report-template-editor-utils.test.ts passed');
