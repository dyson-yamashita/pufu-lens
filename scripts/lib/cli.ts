export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

export function validateGraphName(graphName: unknown): string {
  if (
    typeof graphName !== 'string' ||
    !/^graph_[a-z0-9_]+$/.test(graphName) ||
    graphName.length > 63
  ) {
    throw new Error(`Invalid AGE graph name: ${graphName}`);
  }
  return graphName;
}
