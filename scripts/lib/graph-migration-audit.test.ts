import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalizeInventoryEdgeEndpoints,
  compareGraphInventories,
  type GraphInventory,
  type GraphSourceAuditSummary,
  normalizeStructuralStringSet,
} from './graph-migration-audit.ts';

const emptyAudit = (): GraphSourceAuditSummary => ({
  currentDocumentMissingParsedOrStatus: 0,
  currentLifecycleOnlyDocument: 0,
  mergedActorAliasReference: 0,
  mergedActorEmailQuoteReference: 0,
  mergedActorMissingMergeDecision: 0,
  relationalDocumentNodeWithoutDocumentRow: 0,
});

test('canonicalizeInventoryEdgeEndpoints keeps directed edges and canonicalizes SAME_AS pairs', () => {
  assert.deepEqual(canonicalizeInventoryEdgeEndpoints('RELATED_TO', 'digest-b', 'digest-a'), {
    sourceIdentityDigest: 'digest-b',
    targetIdentityDigest: 'digest-a',
  });
  assert.deepEqual(canonicalizeInventoryEdgeEndpoints('SAME_AS', 'digest-b', 'digest-a'), {
    sourceIdentityDigest: 'digest-a',
    targetIdentityDigest: 'digest-b',
  });
});

test('compareGraphInventories treats reverse SAME_AS duplicates as matching inventories', () => {
  const inventory: GraphInventory = {
    edges: [
      {
        propertyKeys: ['confidence'],
        relationType: 'SAME_AS',
        sourceIdentityDigest: 'digest-a',
        targetIdentityDigest: 'digest-b',
      },
    ],
    nodes: [
      { identityDigest: 'digest-a', labels: ['Document'], propertyKeys: ['docType'] },
      { identityDigest: 'digest-b', labels: ['Document'], propertyKeys: ['docType'] },
    ],
    truncated: false,
  };
  const reverse: GraphInventory = {
    edges: [
      {
        propertyKeys: ['confidence'],
        relationType: 'SAME_AS',
        sourceIdentityDigest: 'digest-b',
        targetIdentityDigest: 'digest-a',
      },
    ],
    nodes: [...inventory.nodes],
    truncated: false,
  };

  const summary = compareGraphInventories({
    age: inventory,
    relational: reverse,
    sourceAudit: emptyAudit(),
  });

  assert.equal(summary.gateStatus, 'pass');
  assert.equal(summary.duplicateEdgeCount, 0);
  assert.equal(summary.ageOnlyEdgeCount, 0);
});

test('compareGraphInventories ignores reversed label and property key ordering', () => {
  const age: GraphInventory = {
    edges: [],
    nodes: [
      {
        identityDigest: 'digest-doc',
        labels: ['Document', 'Issue'],
        propertyKeys: ['docType', 'projectId', 'title'],
      },
    ],
    truncated: false,
  };
  const relational: GraphInventory = {
    edges: [],
    nodes: [
      {
        identityDigest: 'digest-doc',
        labels: ['Issue', 'Document'],
        propertyKeys: ['title', 'projectId', 'docType'],
      },
    ],
    truncated: false,
  };

  const summary = compareGraphInventories({ age, relational, sourceAudit: emptyAudit() });
  assert.equal(summary.gateStatus, 'pass');
  assert.equal(summary.edgeLabelPropertyKeyMismatchCount, 0);
  assert.deepEqual(normalizeStructuralStringSet(['Issue', 'Document']), ['Document', 'Issue']);
});

test('compareGraphInventories classifies directed edge drift, unknown types, and orphans', () => {
  const age: GraphInventory = {
    edges: [
      {
        propertyKeys: ['role'],
        relationType: 'AUTHORED',
        sourceIdentityDigest: 'actor-a',
        targetIdentityDigest: 'doc-a',
      },
      {
        propertyKeys: [],
        relationType: 'UNKNOWN_EDGE',
        sourceIdentityDigest: 'doc-a',
        targetIdentityDigest: 'doc-b',
      },
      {
        propertyKeys: [],
        relationType: 'MENTIONS',
        sourceIdentityDigest: 'doc-a',
        targetIdentityDigest: 'missing-topic',
      },
    ],
    nodes: [
      { identityDigest: 'actor-a', labels: ['Actor'], propertyKeys: ['displayName'] },
      { identityDigest: 'doc-a', labels: ['Document', 'Issue'], propertyKeys: ['docType'] },
    ],
    truncated: false,
  };
  const relational: GraphInventory = {
    edges: [
      {
        propertyKeys: ['role'],
        relationType: 'AUTHORED',
        sourceIdentityDigest: 'actor-a',
        targetIdentityDigest: 'doc-b',
      },
    ],
    nodes: [
      { identityDigest: 'actor-a', labels: ['Actor'], propertyKeys: ['displayName'] },
      { identityDigest: 'doc-b', labels: ['Document', 'Issue'], propertyKeys: ['docType'] },
    ],
    truncated: false,
  };

  const summary = compareGraphInventories({
    age,
    relational,
    sourceAudit: emptyAudit(),
  });

  assert.equal(summary.gateStatus, 'blocked');
  assert.equal(summary.unknownRelationTypeCount, 1);
  assert.equal(summary.orphanEdgeCount, 2);
  assert.equal(summary.ageOnlyEdgeCount, 2);
  assert.equal(summary.relationalOnlyEdgeCount, 1);
  assert.equal(summary.ageOnlyNodeCount, 1);
  assert.equal(summary.relationalOnlyNodeCount, 1);
});

test('compareGraphInventories detects property key drift and logical duplicates', () => {
  const inventory: GraphInventory = {
    edges: [
      {
        propertyKeys: ['role'],
        relationType: 'SENT',
        sourceIdentityDigest: 'actor-a',
        targetIdentityDigest: 'doc-a',
      },
      {
        propertyKeys: ['role'],
        relationType: 'SENT',
        sourceIdentityDigest: 'actor-a',
        targetIdentityDigest: 'doc-a',
      },
    ],
    nodes: [
      { identityDigest: 'actor-a', labels: ['Actor'], propertyKeys: ['displayName'] },
      { identityDigest: 'doc-a', labels: ['Document'], propertyKeys: ['docType', 'title'] },
      { identityDigest: 'doc-a', labels: ['Document'], propertyKeys: ['docType', 'title'] },
    ],
    truncated: false,
  };

  const summary = compareGraphInventories({
    age: inventory,
    relational: {
      edges: [
        {
          propertyKeys: ['role', 'actorId'],
          relationType: 'SENT',
          sourceIdentityDigest: 'actor-a',
          targetIdentityDigest: 'doc-a',
        },
      ],
      nodes: [
        { identityDigest: 'actor-a', labels: ['Actor'], propertyKeys: ['displayName'] },
        { identityDigest: 'doc-a', labels: ['Document'], propertyKeys: ['docType'] },
      ],
      truncated: false,
    },
    sourceAudit: emptyAudit(),
  });

  assert.equal(summary.duplicateNodeCount, 1);
  assert.equal(summary.duplicateEdgeCount, 1);
  assert.equal(summary.edgeLabelPropertyKeyMismatchCount, 2);
});

test('compareGraphInventories is inconclusive when truncated', () => {
  const inventory: GraphInventory = { edges: [], nodes: [], truncated: true };
  const truncated = compareGraphInventories({
    age: inventory,
    relational: { edges: [], nodes: [], truncated: false },
    sourceAudit: emptyAudit(),
  });
  assert.equal(truncated.gateStatus, 'inconclusive');
});

test('compareGraphInventories does not block on lifecycle-only audit count alone', () => {
  const lifecycleOnly = compareGraphInventories({
    age: { edges: [], nodes: [], truncated: false },
    relational: { edges: [], nodes: [], truncated: false },
    sourceAudit: {
      ...emptyAudit(),
      currentLifecycleOnlyDocument: 3,
    },
  });
  assert.equal(lifecycleOnly.gateStatus, 'pass');
  assert.equal(lifecycleOnly.sourceAudit.currentLifecycleOnlyDocument, 3);
});

test('compareGraphInventories blocks on actual source audit blockers', () => {
  const blocked = compareGraphInventories({
    age: { edges: [], nodes: [], truncated: false },
    relational: { edges: [], nodes: [], truncated: false },
    sourceAudit: {
      ...emptyAudit(),
      mergedActorAliasReference: 1,
    },
  });
  assert.equal(blocked.gateStatus, 'blocked');
});

test('compareGraphInventories summary JSON omits fixture identifiers and property values', () => {
  const summary = compareGraphInventories({
    age: {
      edges: [
        {
          propertyKeys: ['secret-title'],
          relationType: 'MENTIONS',
          sourceIdentityDigest: 'digest-doc-secret',
          targetIdentityDigest: 'digest-topic-secret',
        },
      ],
      nodes: [
        {
          identityDigest: 'digest-doc-secret',
          labels: ['Document'],
          propertyKeys: ['document-secret-value'],
        },
      ],
      truncated: false,
    },
    relational: { edges: [], nodes: [], truncated: false },
    sourceAudit: emptyAudit(),
  });
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes('digest-doc-secret'), false);
  assert.equal(serialized.includes('document-secret-value'), false);
  assert.equal(serialized.includes('secret-title'), false);
  assert.equal(typeof summary.ageOnlyNodeCount, 'number');
});
