CREATE TABLE keyword_documents (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL CHECK (length(trim(document_id)) > 0),
  raw_document_id TEXT NOT NULL CHECK (length(trim(raw_document_id)) > 0),
  doc_type TEXT NOT NULL,
  title TEXT NOT NULL,
  canonical_uri TEXT NOT NULL,
  PRIMARY KEY (project_id, document_id)
);
CREATE TABLE keyword_chunks (
  project_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL CHECK (length(trim(chunk_id)) > 0),
  document_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK (typeof(chunk_index) = 'integer' AND chunk_index >= 0),
  content TEXT NOT NULL CHECK (length(CAST(content AS BLOB)) <= 8000),
  normalized_content TEXT NOT NULL CHECK (length(CAST(normalized_content AS BLOB)) <= 8000),
  PRIMARY KEY (project_id, chunk_id),
  UNIQUE (project_id, document_id, chunk_index),
  FOREIGN KEY (project_id, document_id) REFERENCES keyword_documents(project_id, document_id) ON DELETE CASCADE
);
CREATE TABLE keyword_characters (
  project_id TEXT NOT NULL,
  token TEXT NOT NULL CHECK (length(token) = 1),
  chunk_id TEXT NOT NULL,
  PRIMARY KEY (project_id, token, chunk_id),
  FOREIGN KEY (project_id, chunk_id) REFERENCES keyword_chunks(project_id, chunk_id) ON DELETE CASCADE
);
CREATE INDEX keyword_character_cleanup ON keyword_characters(project_id, chunk_id);
