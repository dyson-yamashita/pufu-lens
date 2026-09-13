import assert from 'node:assert/strict';
import test from 'node:test';
import type { GraphReadRepository } from './index.js';
import { GraphReadUnavailableError } from './postgres-relational-common.js';
import {
  createGraphPrimaryReadRepository,
  type GraphPrimaryReadObservation,
} from './primary-read.js';
import { createGraphShadowMutationRepository, parseGraphTransitionMode } from './shadow.js';

const preset = {
  nodes: [],
  edges: [],
  rawRows: [],
  rowCount: 0,
  truncated: false,
  preview: 'fixture',
};
const empty: GraphReadRepository = {
  countDocumentNode: async () => 0,
  countRelations: async () => ({ SAME_AS: 0 }),
  findRelatedDocuments: async () => ({ candidates: [], status: 'success' }),
  readPreset: async () => preset,
};
const input = {
  projectId: 'fixture-project',
  graphNodeId: 'document:fixture',
  relationTypes: ['SAME_AS'] as const,
  seedDocumentIds: ['fixture-seed'],
  documentGraphNodeIds: ['document:fixture'],
  presetId: 'actor-documents' as const,
};
const methods = [
  'countDocumentNode',
  'countRelations',
  'findRelatedDocuments',
  'readPreset',
] as const;

test('server-owned primary mode is explicit and legacy default remains off', () => {
  assert.equal(parseGraphTransitionMode('relational-primary'), 'relational-primary');
  assert.equal(parseGraphTransitionMode(undefined), 'off');
});

test('relational-primary keeps AGE first dual writes and secondary failure propagation', async () => {
  const calls: string[] = [];
  const mutation = {
    deleteDocumentGraphNodes: async () => 0,
    deleteProjectGraph: async () => {},
    ensureProjectGraph: async () => {},
    mergeActorGraphNodes: async () => ({ status: 'unavailable' as const }),
    upsertEdge: async () => {},
    upsertNode: async () => {},
  };
  const repository = createGraphShadowMutationRepository({
    mode: 'relational-primary',
    primary: {
      ...mutation,
      ensureProjectGraph: async () => {
        calls.push('AGE');
      },
    },
    shadow: {
      ...mutation,
      ensureProjectGraph: async () => {
        calls.push('relational');
        throw new Error('failed');
      },
    },
  });
  await assert.rejects(
    repository.ensureProjectGraph({ projectId: input.projectId }),
    /Graph shadow mutation failed/,
  );
  assert.deepEqual(calls, ['AGE', 'relational']);
});

for (const method of methods) {
  test(`${method}: authoritative empty results never call AGE`, async () => {
    const fallback = {
      ...empty,
      [method]: async () => {
        assert.fail('AGE must not run');
      },
    };
    const reader = createGraphPrimaryReadRepository({ primary: empty, fallback });
    assert.deepEqual(await reader[method](input), await empty[method](input));
  });
  test(`${method}: unavailable falls back once with the identical scoped input`, async () => {
    let calls = 0;
    const primary = {
      ...empty,
      [method]: async () => {
        throw new GraphReadUnavailableError();
      },
    };
    const fallback = {
      ...empty,
      [method]: async (actual: unknown) => {
        calls++;
        assert.equal(actual, input);
        return empty[method](input);
      },
    };
    const observations: GraphPrimaryReadObservation[] = [];
    const reader = createGraphPrimaryReadRepository({
      primary,
      fallback,
      observer: (event) => {
        observations.push(event);
      },
    });
    assert.deepEqual(await reader[method](input), await empty[method](input));
    assert.equal(calls, 1);
    assert.equal(observations[0]?.outcome, 'fallback_success');
    assert.doesNotMatch(JSON.stringify(observations), /fixture/);
  });
  test(`${method}: unexpected and permission failures do not call AGE`, async () => {
    for (const error of [
      new Error('invalid input'),
      Object.assign(new Error('denied'), { code: '42501' }),
    ]) {
      const primary = {
        ...empty,
        [method]: async () => {
          throw error;
        },
      };
      const fallback = {
        ...empty,
        [method]: async () => {
          assert.fail('AGE must not run');
        },
      };
      await assert.rejects(
        createGraphPrimaryReadRepository({ primary, fallback })[method](input),
        (actual) => actual === error,
      );
    }
  });
  test(`${method}: both backend failures preserve the unavailable contract`, async () => {
    const primary = {
      ...empty,
      [method]: async () => {
        throw new GraphReadUnavailableError();
      },
    };
    const fallback = {
      ...empty,
      [method]: async () => {
        throw new Error('secret SQL');
      },
    };
    const result = createGraphPrimaryReadRepository({ primary, fallback })[method](input);
    if (method === 'findRelatedDocuments') {
      assert.deepEqual(await result, { candidates: [], status: 'unavailable' });
    } else {
      await assert.rejects(result, {
        name: 'GraphReadUnavailableError',
        message: 'Graph read capability unavailable.',
      });
    }
  });
}

test('related unavailable status triggers AGE while candidate order/hop/relation stay intact', async () => {
  const result = {
    candidates: [
      {
        documentId: 'a',
        seedDocumentId: 'b',
        hopCount: 2 as const,
        relationType: 'MENTIONS' as const,
      },
    ],
    status: 'success' as const,
  };
  const reader = createGraphPrimaryReadRepository({
    primary: {
      ...empty,
      findRelatedDocuments: async () => ({ candidates: [], status: 'unavailable' }),
    },
    fallback: { ...empty, findRelatedDocuments: async () => result },
  });
  assert.equal(await reader.findRelatedDocuments(input), result);
});

test('both presets preserve successful response identity', async () => {
  for (const presetId of ['actor-documents', 'recent-relations'] as const) {
    assert.equal(
      await createGraphPrimaryReadRepository({ primary: empty, fallback: empty }).readPreset({
        ...input,
        presetId,
      }),
      preset,
    );
  }
});

test('deadlines cover primary and fallback; late rejection and stuck observer do not block', async () => {
  const callbacks: (() => void)[] = [];
  const cancelled: unknown[] = [];
  let rejectLate: (error: Error) => void = () => {};
  const reader = createGraphPrimaryReadRepository({
    primary: {
      ...empty,
      countDocumentNode: () =>
        new Promise((_resolve, reject) => {
          rejectLate = reject;
        }),
    },
    fallback: { ...empty, countDocumentNode: () => new Promise(() => {}) },
    observer: () => new Promise(() => {}),
    scheduleTimeout: (callback, delay) => {
      assert.equal(delay, 6000);
      callbacks.push(callback);
      return callback;
    },
    cancelTimeout: (handle) => {
      cancelled.push(handle);
    },
  });
  const result = reader.countDocumentNode(input);
  const rejected = assert.rejects(result, GraphReadUnavailableError);
  await new Promise<void>((resolve) => setImmediate(resolve));
  callbacks[0]?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  callbacks[1]?.();
  await rejected;
  rejectLate(new Error('late private failure'));
  assert.equal(cancelled.length, 2);
});
