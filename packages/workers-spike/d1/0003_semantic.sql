CREATE TABLE semantic_versions (
  project_id TEXT NOT NULL REFERENCES projects(id),
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision > 0),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  PRIMARY KEY(project_id, document_id, revision)
);
CREATE TABLE semantic_heads (
  project_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY(project_id, document_id),
  FOREIGN KEY(project_id, document_id, revision)
    REFERENCES semantic_versions(project_id, document_id, revision)
);
CREATE TABLE semantic_outbox (
  project_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','submitted','dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  next_attempt INTEGER NOT NULL DEFAULT 0,
  mutation_id TEXT,
  epoch INTEGER NOT NULL DEFAULT 0 CHECK(epoch >= 0),
  PRIMARY KEY(project_id, document_id, revision),
  FOREIGN KEY(project_id, document_id, revision)
    REFERENCES semantic_versions(project_id, document_id, revision)
);
CREATE INDEX semantic_outbox_pending ON semantic_outbox(project_id, state, next_attempt);
