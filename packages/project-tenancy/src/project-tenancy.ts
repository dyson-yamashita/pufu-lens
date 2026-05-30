const PROJECT_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const GRAPH_NAME_PATTERN = /^graph_[a-z0-9_]+$/;

export interface CreateProjectInput {
  description?: string;
  name: string;
  slug: string;
}

export interface ProjectIdentifiers {
  graphName: string;
  storagePrefix: string;
}

export function validateProjectSlug(slug: string): string {
  if (!PROJECT_SLUG_PATTERN.test(slug)) {
    throw new Error(
      `Invalid project slug: ${slug}. Use lowercase letters, numbers, and hyphens, with no leading or trailing hyphen.`,
    );
  }

  return slug;
}

export function validateGraphName(graphName: string): string {
  if (!GRAPH_NAME_PATTERN.test(graphName)) {
    throw new Error(
      `Invalid graph name: ${graphName}. Graph names must start with graph_ and use lowercase letters, numbers, or underscores.`,
    );
  }

  return graphName;
}

export function deriveProjectIdentifiers(slug: string): ProjectIdentifiers {
  const safeSlug = validateProjectSlug(slug);
  const graphName = validateGraphName(`graph_${safeSlug.replaceAll('-', '_')}`);

  return {
    graphName,
    storagePrefix: safeSlug,
  };
}

export function buildCreateProjectSql(input: CreateProjectInput): string {
  const slug = validateProjectSlug(input.slug);
  const identifiers = deriveProjectIdentifiers(slug);

  return [
    "LOAD 'age';",
    'SET search_path = ag_catalog, "$user", public;',
    'BEGIN;',
    `INSERT INTO public.projects (slug, name, description, graph_name, storage_prefix)`,
    `VALUES (${escapeSqlLiteral(slug)}, ${escapeSqlLiteral(input.name)}, ${escapeOptionalSqlLiteral(
      input.description,
    )}, ${escapeSqlLiteral(identifiers.graphName)}, ${escapeSqlLiteral(identifiers.storagePrefix)})`,
    'ON CONFLICT (slug) DO NOTHING;',
    `SELECT create_graph(${escapeSqlLiteral(identifiers.graphName)})`,
    'WHERE NOT EXISTS (',
    '  SELECT 1 FROM ag_catalog.ag_graph',
    `  WHERE name = ${escapeSqlLiteral(identifiers.graphName)}`,
    ');',
    'COMMIT;',
  ].join('\n');
}

export function escapeSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function escapeOptionalSqlLiteral(value: string | undefined): string {
  return value === undefined ? 'NULL' : escapeSqlLiteral(value);
}
