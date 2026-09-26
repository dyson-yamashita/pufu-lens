-- Local Graph capability schema. projects is the minimal tenant identity table.
CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL CHECK (trim(id) <> ''));
CREATE TABLE graph_nodes (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  node_key TEXT NOT NULL CHECK (trim(node_key) <> ''),
  kind TEXT NOT NULL CHECK (kind IN ('actor','document','topic')),
  subtype TEXT CHECK (subtype IS NULL OR trim(subtype) <> ''),
  properties TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(properties) AND json_type(properties) = 'object'),
  PRIMARY KEY (project_id, node_key)
);
CREATE TABLE graph_edges (
  project_id TEXT NOT NULL,
  source_node_key TEXT NOT NULL,
  target_node_key TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN
    ('AUTHORED','COMMENTED_ON','MENTIONS','OWNS','REPLY_TO','RELATED_TO','REVIEWED','SAME_AS','SENT')),
  properties TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(properties) AND json_type(properties) = 'object'),
  PRIMARY KEY (project_id, source_node_key, target_node_key, relation_type),
  FOREIGN KEY (project_id, source_node_key) REFERENCES graph_nodes(project_id,node_key) ON DELETE CASCADE,
  FOREIGN KEY (project_id, target_node_key) REFERENCES graph_nodes(project_id,node_key) ON DELETE CASCADE
);
CREATE INDEX graph_edges_outgoing ON graph_edges(project_id,source_node_key,relation_type,target_node_key);
CREATE INDEX graph_edges_incoming ON graph_edges(project_id,target_node_key,relation_type,source_node_key);
