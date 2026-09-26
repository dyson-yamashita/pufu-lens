import { type D1Binding, record, rows, text } from '../d1/binding.js';
import { type IndexContract, identity, type VectorizeBinding, verifyIndex } from './binding.js';
import { parseSnapshot, storedSnapshot } from './snapshot.js';

export interface OutboxKey {
  projectId: string;
  documentId: string;
  revision: number;
}

/** Validates an untrusted queue key. Messages carry identities only, never vectors or credentials. */
export function outboxKey(value: unknown): OutboxKey {
  const row = record(value);
  if (typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1)
    throw new Error('Invalid revision');
  return {
    projectId: identity(row.projectId),
    documentId: text(row.documentId),
    revision: row.revision,
  };
}

/** Commits immutable data, monotonic head and delivery intent in one D1 batch.
 * Identical retries preserve snapshot/head and may requeue obsolete cleanup; conflicting revision reuse fails the batch.
 * Older revisions cannot roll back the head. No Vectorize request occurs in this transaction.
 */
export async function enqueueSnapshot(db: D1Binding, value: unknown): Promise<void> {
  const snapshot = await parseSnapshot(value);
  const key = [snapshot.projectId, snapshot.documentId, snapshot.revision];
  const result = await db.batch([
    db
      .prepare(`INSERT INTO semantic_versions VALUES (?1,?2,?3,?4)
      ON CONFLICT(project_id,document_id,revision) DO UPDATE SET payload=
      CASE WHEN payload=excluded.payload THEN payload ELSE NULL END`)
      .bind(...key, JSON.stringify(snapshot)),
    db
      .prepare(`INSERT INTO semantic_heads VALUES (?1,?2,?3)
      ON CONFLICT(project_id,document_id) DO UPDATE SET revision=excluded.revision
      WHERE excluded.revision>revision`)
      .bind(...key),
    db
      .prepare(`INSERT INTO semantic_outbox(project_id,document_id,revision) VALUES (?1,?2,?3)
      ON CONFLICT DO NOTHING`)
      .bind(...key),
    db
      .prepare(`UPDATE semantic_outbox SET state='pending',attempts=0,next_attempt=0,mutation_id=NULL,epoch=epoch+1
      WHERE project_id=?1 AND document_id=?2 AND revision<?3
      AND ?3=(SELECT revision FROM semantic_heads WHERE project_id=?1 AND document_id=?2)`)
      .bind(...key),
  ]);
  result.forEach(rows);
}

/** Delivers one bounded attempt; duplicate consumers can safely use the same immutable vector IDs.
 * submitted means API acceptance only, never search visibility. Retry scheduling and dead-letter
 * state are durable in D1 (3 attempts, exponential seconds). A queue driver should acknowledge only
 * after this returns and redispatch due pending rows. A thrown D1 error must remain unacknowledged.
 * Old versions are deleted again by repair because late/ambiguous external writes can resurrect IDs.
 */
export async function deliverOutbox(
  db: D1Binding,
  index: VectorizeBinding,
  config: IndexContract,
  value: unknown,
  now = Date.now(),
): Promise<'submitted' | 'retry' | 'dead' | 'skipped'> {
  const key = outboxKey(value);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid time');
  const args = [key.projectId, key.documentId, key.revision];
  const claimed = rows(
    await db
      .prepare(`UPDATE semantic_outbox SET attempts=attempts+1
    WHERE project_id=?1 AND document_id=?2 AND revision=?3 AND state='pending'
      AND next_attempt<=?4 AND attempts<3 RETURNING attempts,epoch`)
      .bind(...args, now)
      .all(),
  );
  if (!claimed.length) return 'skipped';
  const attempts = record(claimed[0]).attempts;
  const epoch = record(claimed[0]).epoch;
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0)
    throw new Error('Invalid delivery epoch');
  if (typeof attempts !== 'number' || !Number.isInteger(attempts) || attempts < 1 || attempts > 3)
    throw new Error('Invalid attempt row');
  // A crash after claiming leaves pending; repair also recovers exhausted interrupted attempts.
  try {
    await verifyIndex(index, config);
    const result = rows(
      await db
        .prepare(`SELECT v.payload,h.revision AS head_revision
      FROM semantic_versions v JOIN semantic_heads h USING(project_id,document_id)
      WHERE v.project_id=?1 AND v.document_id=?2 AND v.revision=?3`)
        .bind(...args)
        .all(),
    );
    if (result.length !== 1) throw new Error('Missing outbox snapshot');
    const row = record(result[0]);
    const snapshot = await storedSnapshot(row.payload);
    if (
      snapshot.projectId !== key.projectId ||
      snapshot.documentId !== key.documentId ||
      snapshot.revision !== key.revision ||
      snapshot.model !== config.model ||
      typeof row.head_revision !== 'number' ||
      !Number.isSafeInteger(row.head_revision) ||
      row.head_revision < snapshot.revision
    )
      throw new Error('Invalid outbox scope');
    let mutationId: string | null = null;
    const ids = snapshot.chunks.map((c) => c.vectorId);
    if (ids.length) {
      const response =
        row.head_revision === snapshot.revision
          ? await index.upsert(
              snapshot.chunks.map((c) => ({
                id: c.vectorId,
                values: c.values,
                namespace: snapshot.projectId,
                metadata: {
                  projectId: snapshot.projectId,
                  model: snapshot.model,
                  revision: snapshot.revision,
                },
              })),
            )
          : await index.deleteByIds(ids);
      mutationId = text(record(response).mutationId);
    }
    rows(
      await db
        .prepare(`UPDATE semantic_outbox SET state='submitted',mutation_id=?4
      WHERE project_id=?1 AND document_id=?2 AND revision=?3 AND epoch=?5`)
        .bind(...args, mutationId, epoch)
        .all(),
    );
    return 'submitted';
  } catch {
    // Do not persist provider error text, content or secrets.
    const state = attempts >= 3 ? 'dead' : 'pending';
    rows(
      await db
        .prepare(`UPDATE semantic_outbox SET state=?4,next_attempt=?5
      WHERE project_id=?1 AND document_id=?2 AND revision=?3 AND state='pending' AND epoch=?6`)
        .bind(...args, state, now + 1000 * 2 ** (attempts - 1), epoch)
        .all(),
    );
    return state === 'dead' ? 'dead' : 'retry';
  }
}

/** Requeues one known revision, including dead letters and accepted-but-lost writes.
 * Repair all retained revisions of a document to re-upsert the head and delete obsolete IDs.
 * Never remove the immutable history before external cleanup has been independently verified.
 */
export async function repairOutbox(db: D1Binding, value: unknown): Promise<boolean> {
  const key = outboxKey(value);
  return (
    rows(
      await db
        .prepare(`UPDATE semantic_outbox
    SET state='pending',attempts=0,next_attempt=0,mutation_id=NULL,epoch=epoch+1
    WHERE project_id=?1 AND document_id=?2 AND revision=?3 RETURNING revision`)
        .bind(key.projectId, key.documentId, key.revision)
        .all(),
    ).length === 1
  );
}

/** Lists a bounded page of durable delivery state for local dispatch/repair; no content is exposed. */
export async function inspectOutbox(db: D1Binding, projectId: string, documentId: string) {
  const result = rows(
    await db
      .prepare(`SELECT revision,state,attempts,next_attempt,mutation_id
    FROM semantic_outbox WHERE project_id=?1 AND document_id=?2 ORDER BY revision LIMIT 101`)
      .bind(identity(projectId), text(documentId))
      .all(),
  );
  if (result.length > 100) throw new Error('Outbox inspection budget exceeded');
  return result.map((value) => {
    const row = record(value);
    const key = outboxKey({ projectId, documentId, revision: row.revision });
    if (
      !['pending', 'submitted', 'dead'].includes(text(row.state)) ||
      typeof row.attempts !== 'number' ||
      !Number.isInteger(row.attempts) ||
      row.attempts < 0 ||
      typeof row.next_attempt !== 'number' ||
      !Number.isSafeInteger(row.next_attempt) ||
      row.next_attempt < 0 ||
      (row.mutation_id !== null && typeof row.mutation_id !== 'string')
    )
      throw new Error('Invalid outbox row');
    return {
      ...key,
      state: row.state,
      attempts: row.attempts,
      nextAttempt: row.next_attempt,
      mutationId: row.mutation_id,
    };
  });
}
