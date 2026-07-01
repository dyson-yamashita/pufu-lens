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
  decodePartRef,
  encodePartRef,
  layoutToJson,
  moveChildInRow,
  moveLayoutPart,
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

const json = layoutToJson(updateLayoutRoot(removed, replaced));
assert.ok(json.includes('schema_version'));
validateCustomReportLayout(JSON.parse(json) as unknown);

assert.throws(
  () => updatePartAtPath(columnsPart, ['columns', 0], (part) => part),
  /Invalid column path/,
);

const textPart = createDefaultPart(
  'fixed_text',
  collectPartIds(removed),
  collectResultKeys(removed),
);
const dividerPart = createDefaultPart(
  'divider',
  collectPartIds(removed),
  collectResultKeys(removed),
);
const rowWithTwoChildren = updateLayoutRoot(removed, {
  id: 'root-row',
  type: 'row',
  children: [textPart, dividerPart],
});

if (rowWithTwoChildren.root.type === 'row') {
  const reordered = moveLayoutPart(
    rowWithTwoChildren.root,
    {
      containerPath: [],
      kind: 'row',
      childIndex: 1,
    },
    {
      containerPath: [],
      kind: 'row',
    },
    0,
  );
  if (reordered.type === 'row') {
    assert.equal(reordered.children[0]?.type, 'divider');
    assert.equal(reordered.children[1]?.type, 'fixed_text');
  }
}

resetEditorIdCounter();
const crossColumnIds = new Set<string>();
const crossColumnKeys = new Set<string>();
const col0Text = createDefaultPart('fixed_text', crossColumnIds, crossColumnKeys);
crossColumnIds.add(col0Text.id);
const col0Title = createDefaultPart('title', crossColumnIds, crossColumnKeys);
crossColumnIds.add(col0Title.id);
const col1Text = createDefaultPart('fixed_text', crossColumnIds, crossColumnKeys);
const columnsRoot = {
  id: 'root-row',
  type: 'row' as const,
  children: [
    {
      id: 'main-columns',
      type: 'columns' as const,
      columns: [
        { width_fraction: 0.5, children: [col0Text, col0Title] },
        { width_fraction: 0.5, children: [col1Text] },
      ],
    },
  ],
};

const movedAcrossColumns = moveLayoutPart(
  columnsRoot,
  { containerPath: ['children', 0], kind: 'column', columnIndex: 0, childIndex: 1 },
  { containerPath: ['children', 0], kind: 'column', columnIndex: 1 },
  0,
);
if (movedAcrossColumns.type === 'row' && movedAcrossColumns.children[0]?.type === 'columns') {
  assert.equal(movedAcrossColumns.children[0].columns[1]?.children[0]?.type, 'title');
  assert.equal(movedAcrossColumns.children[0].columns[0]?.children.length, 1);
}

const nestedRowRoot = {
  id: 'root-row',
  type: 'row' as const,
  children: [
    {
      id: 'outer-row',
      type: 'row' as const,
      children: [{ id: 'nested-title', type: 'title' as const, level: 2 as const, text: 'Nested' }],
    },
    { id: 'root-divider', type: 'divider' as const },
  ],
};
assert.equal(
  moveLayoutPart(
    nestedRowRoot,
    { containerPath: [], kind: 'row', childIndex: 0 },
    { containerPath: ['children', 0], kind: 'row' },
    0,
  ),
  nestedRowRoot,
);

const encoded = encodePartRef({ containerPath: [], kind: 'row', childIndex: 0 });
assert.deepEqual(decodePartRef(encoded), { containerPath: [], kind: 'row', childIndex: 0 });

console.log('custom-report-template-editor-utils.test.ts passed');
