import assert from 'node:assert/strict';
import test from 'node:test';
import { collectGraphParity, parseGraphState } from './parity-graph.ts';

test('persisted snapshot guards reject malformed rows and retain properties and extra edges', () => {
  const node = {
    project_id: 'alpha',
    node_key: 'd01',
    kind: 'document',
    subtype: null,
    properties: '{}',
  };
  const edge = {
    project_id: 'alpha',
    source_node_key: 'd01',
    target_node_key: 'd02',
    relation_type: 'RELATED_TO',
    properties: { flag: true },
  };
  const state = parseGraphState([node], [edge, edge]);
  assert.equal(state.graph.length, 3);
  assert.equal(state.records.length, 3);
  assert.throws(() => parseGraphState([{ ...node, properties: '[]' }], []));
  assert.throws(() => parseGraphState([{ ...node, kind: 'invalid' }], []));
  assert.throws(() => parseGraphState([], [{ ...edge, source_node_key: 1 }]));
  assert.throws(() => parseGraphState([null], []));
});

test('successful no-op mutations and empty reads cannot counterfeit scope or mutation evidence', async () => {
  const result = await collectGraphParity({
    mutation: {
      ensureProjectGraph: async () => {},
      deleteProjectGraph: async () => {},
      upsertNode: async () => {},
      upsertEdge: async () => {},
      deleteDocumentGraphNodes: async () => 2,
      mergeActorGraphNodes: async () => ({ status: 'merged', deletedCount: 1 }),
    },
    read: { findRelatedDocuments: async () => ({ status: 'success', candidates: [] }) },
    snapshot: async () => ({ graph: [], records: [] }),
  });
  assert.equal(result.rows.length, 17);
  assert.ok(result.rows.every((r) => !r.scopePass && !r.mutationPass));
  assert.ok(result.rows.every((r) => r.graph.length === 0 && r.rubricPass === null));
});
