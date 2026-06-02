import { createHash } from 'node:crypto';
import postgres from 'postgres';

async function main(): Promise<any> {
  const options = parseArgs(process.argv.slice(2));
  const projectSlug = requiredOption(options.project, '--project');
  const cypher = requiredOption(options.cypher, '--cypher');
  const sql = postgres(requiredEnv('DATABASE_URL'), { max: 1 });

  try {
    await ensureAgeSession(sql);
    const project = singleJson(
      await sql`
        SELECT graph_name AS "graphName"
        FROM public.projects
        WHERE slug = ${projectSlug}
      `,
    );
    if (!project) {
      throw new Error(`Project not found: ${projectSlug}`);
    }
    const graphName = validateGraphName(project.graphName);
    const rows = await sql.unsafe(
      `SELECT * FROM cypher(${sqlString(graphName)}, ${dollarQuote(cypher)}) AS (value agtype)`,
    );
    console.log(JSON.stringify(rows, null, 2));
  } finally {
    await sql.end();
  }
}

async function ensureAgeSession(sql: any): Promise<any> {
  await sql.unsafe("LOAD 'age'");
  await sql.unsafe('SET search_path = ag_catalog, "$user", public');
}

function parseArgs(argv: any): any {
  const options: any = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--project') {
      options.project = readOptionValue(argv, ++index, arg);
    } else if (arg === '--cypher') {
      options.cypher = readOptionValue(argv, ++index, arg);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function readOptionValue(argv: any, index: any, optionName: any): any {
  const value = argv[index];
  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }
  return value;
}

function requiredEnv(name: any): any {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function requiredOption(value: any, name: any): any {
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function singleJson(rows: any): any {
  return rows[0];
}

function sqlString(value: any): any {
  return `'${value.replace(/'/g, "''")}'`;
}

function dollarQuote(value: any): any {
  const tag = `$pufu_${createHash('sha256').update(value).digest('hex')}$`;
  return `${tag}${value}${tag}`;
}

function validateGraphName(graphName: any): any {
  if (!/^graph_[a-z0-9_]+$/.test(graphName) || graphName.length > 63) {
    throw new Error(`Invalid AGE graph name: ${graphName}`);
  }
  return graphName;
}

main().catch((error: any): any => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
