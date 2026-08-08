type SubscriptionProjectActorRow = {
  id: string;
  enabled: boolean;
  preferred_username: string;
};

type SubscriptionSettingsActorRow = SubscriptionProjectActorRow & {
  project_id: string;
};

type OutboundFollowSubscriptionRow = {
  remote_actor_uri: string;
  remote_inbox_uri: string;
  remote_shared_inbox_uri: string | null;
};

function parseRowObject(row: unknown, context: string): Record<string, unknown> {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error(`${context} must be an object row`);
  }
  return row as Record<string, unknown>;
}

function parseRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function parseRequiredBoolean(value: unknown, fieldName: string): boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`${fieldName} must be a boolean`);
  }
  return value;
}

function parseNullableString(value: unknown, fieldName: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string or null`);
  }
  return value;
}

function parseSubscriptionProjectActorRow(row: unknown): SubscriptionProjectActorRow {
  const record = parseRowObject(row, 'subscription project actor row');
  return {
    id: parseRequiredString(record.id, 'id'),
    enabled: parseRequiredBoolean(record.enabled, 'enabled'),
    preferred_username: parseRequiredString(record.preferred_username, 'preferred_username'),
  };
}

function parseSubscriptionSettingsActorRow(row: unknown): SubscriptionSettingsActorRow {
  const record = parseRowObject(row, 'subscription settings actor row');
  return {
    ...parseSubscriptionProjectActorRow(record),
    project_id: parseRequiredString(record.project_id, 'project_id'),
  };
}

function parseOutboundFollowSubscriptionRow(row: unknown): OutboundFollowSubscriptionRow {
  const record = parseRowObject(row, 'outbound follow subscription row');
  return {
    remote_actor_uri: parseRequiredString(record.remote_actor_uri, 'remote_actor_uri'),
    remote_inbox_uri: parseRequiredString(record.remote_inbox_uri, 'remote_inbox_uri'),
    remote_shared_inbox_uri: parseNullableString(
      record.remote_shared_inbox_uri,
      'remote_shared_inbox_uri',
    ),
  };
}

export {
  type OutboundFollowSubscriptionRow,
  parseOutboundFollowSubscriptionRow,
  parseSubscriptionProjectActorRow,
  parseSubscriptionSettingsActorRow,
  type SubscriptionProjectActorRow,
  type SubscriptionSettingsActorRow,
};
