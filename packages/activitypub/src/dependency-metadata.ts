/** Pinned Fedify package version for ActivityPub integration. */
export const FEDIFY_PINNED_VERSION = '2.3.4' as const;

/** Minimum resolved Fedify versions that include required security fixes. */
export const FEDIFY_SECURITY_VERSION_FLOORS = {
  '@fedify/vocab-runtime': '2.2.4',
  '@fedify/fedify': '2.3.2',
} as const;

/** Minimum supported Node.js major version for ActivityPub workers. */
export const NODE_RUNTIME_MIN_MAJOR = 22 as const;
