import { type D1Binding, type D1Result, type D1Statement, record } from '../d1/binding.js';
import type { VectorizeBinding } from '../vectorize/binding.js';

/** Measures successful D1 statements and attempted Vectorize operations for the synthetic runner.
 * No SQL, vector, content or credential is recorded. Missing metadata marks the sample incomplete;
 * failed statements may have unreported work, so the runner must stop on incomplete samples.
 */
export function measureBindings(db: D1Binding, index: VectorizeBinding) {
  const usage = {
    rowsRead: 0,
    rowsWritten: 0,
    databaseBytes: 0,
    queries: 0,
    upsertedVectors: 0,
    complete: true,
  };
  const originals = new WeakMap<D1Statement, D1Statement>();
  const measure = (result: D1Result) => {
    try {
      const meta = record(record(result).meta);
      for (const key of ['rows_read', 'rows_written', 'size_after'])
        if (typeof meta[key] !== 'number' || !Number.isSafeInteger(meta[key]) || meta[key] < 0)
          throw new Error('Missing D1 metric');
      usage.rowsRead += Number(meta.rows_read);
      usage.rowsWritten += Number(meta.rows_written);
      usage.databaseBytes = Math.max(usage.databaseBytes, Number(meta.size_after));
    } catch {
      usage.complete = false;
    }
    return result;
  };
  const wrap = (statement: D1Statement): D1Statement => {
    const wrapped: D1Statement = {
      bind: (...values) => wrap(statement.bind(...values)),
      async all() {
        try {
          return measure(await statement.all());
        } catch {
          usage.complete = false;
          throw new Error('D1 unavailable');
        }
      },
    };
    originals.set(wrapped, statement);
    return wrapped;
  };
  const measuredDb: D1Binding = {
    prepare: (sql) => wrap(db.prepare(sql)),
    async batch(statements) {
      try {
        return (
          await db.batch(
            statements.map((statement) => {
              const original = originals.get(statement);
              if (!original) throw new Error('Foreign statement');
              return original;
            }),
          )
        ).map(measure);
      } catch {
        usage.complete = false;
        throw new Error('D1 unavailable');
      }
    },
  };
  const measuredIndex: VectorizeBinding = {
    describe: () => index.describe(),
    query(values, options) {
      usage.queries++;
      return index.query(values, options);
    },
    upsert(vectors) {
      usage.upsertedVectors += vectors.length;
      return index.upsert(vectors);
    },
    deleteByIds: (ids) => index.deleteByIds(ids),
  };
  return { db: measuredDb, index: measuredIndex, usage };
}
