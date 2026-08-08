import { exportJwk, generateCryptoKeyPair, importJwk } from '@fedify/fedify';
import { exportSpki } from '@fedify/vocab-runtime';
import type { ActivityPubRepository } from './actor-repository.ts';
import { decryptPrivateJwk, encryptPrivateJwk } from './key-encryption.ts';
import type {
  ActivityPubActor,
  ActivityPubInstanceConfig,
  ActivityPubProjectScope,
  ObjectRepresentation,
  PublicReportArticle,
} from './schema.ts';

type MutableActor = {
  actor: ActivityPubActor;
  encryptedPrivateKey: ReturnType<typeof encryptPrivateJwk>;
};

type ProjectRecord = ActivityPubProjectScope;

/** In-memory ActivityPub repository for protocol contract tests. */
export function createInMemoryActivityPubRepository(input: {
  encryptionKey: Buffer;
  canonicalOrigin: string;
}): ActivityPubRepository & {
  seedAggregateActor(): Promise<ActivityPubActor>;
  seedProject(input: ProjectRecord): void;
  seedProjectActor(actor: {
    projectId: string;
    projectSlug: string;
    projectName?: string;
    preferredUsername: string;
    visibility: 'public' | 'private';
    enabled: boolean;
  }): Promise<ActivityPubActor>;
  seedPublicReport(report: PublicReportArticle): void;
  setProjectVisibility(projectId: string, visibility: 'public' | 'private'): void;
  setInstanceObjectRepresentation(objectRepresentation: ObjectRepresentation): void;
} {
  const actors = new Map<string, MutableActor>();
  const actorsByUsername = new Map<string, string>();
  const actorsByProjectId = new Map<string, string>();
  const projects = new Map<string, ProjectRecord>();
  const reports = new Map<string, PublicReportArticle>();
  let instanceConfig: ActivityPubInstanceConfig = {
    id: 1,
    objectRepresentation: 'article',
    representationLockedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  const repository: ActivityPubRepository & {
    seedAggregateActor(): Promise<ActivityPubActor>;
    seedProject(input: ProjectRecord): void;
    seedProjectActor(actor: {
      projectId: string;
      projectSlug: string;
      projectName?: string;
      preferredUsername: string;
      visibility: 'public' | 'private';
      enabled: boolean;
    }): Promise<ActivityPubActor>;
    seedPublicReport(report: PublicReportArticle): void;
    setProjectVisibility(projectId: string, visibility: 'public' | 'private'): void;
    setInstanceObjectRepresentation(objectRepresentation: ObjectRepresentation): void;
  } = {
    async runInTransaction(callback) {
      return callback(repository);
    },
    async ensureAggregateActor() {
      const existing = [...actors.values()].find((entry) => entry.actor.kind === 'aggregate');
      if (existing) {
        if (!existing.actor.enabled) {
          existing.actor = { ...existing.actor, enabled: true, updatedAt: new Date() };
        }
        return existing.actor;
      }
      return seedAggregateActorInternal();
    },
    async enableProjectActor(params) {
      const scope = lockProjectScope(params.projectId, params.projectSlug);
      if (scope.visibility !== 'public') {
        throw new Error('Project must be public to manage ActivityPub federation');
      }
      const existingId = actorsByProjectId.get(scope.id);
      if (existingId) {
        const existing = actors.get(existingId);
        if (!existing) {
          throw new Error('Project actor was not found.');
        }
        const preferredUsername =
          params.preferredUsername === undefined
            ? existing.actor.preferredUsername
            : params.preferredUsername;
        if (existing.actor.preferredUsername !== preferredUsername) {
          throw new Error('Existing project actor username is immutable');
        }
        existing.actor = { ...existing.actor, enabled: true, updatedAt: new Date() };
        return existing.actor;
      }
      const preferredUsername = params.preferredUsername ?? params.projectSlug;
      if (preferredUsername === 'all') {
        throw new Error('Project actor preferred username cannot be reserved name all');
      }
      return seedProjectActorInternal({
        projectId: scope.id,
        projectSlug: scope.slug,
        projectName: scope.name,
        preferredUsername,
        visibility: 'public',
        enabled: true,
      });
    },
    async disableProjectActor(params) {
      lockProjectScope(params.projectId, params.projectSlug);
      const existingId = actorsByProjectId.get(params.projectId);
      if (!existingId) {
        throw new Error('Project ActivityPub actor was not found.');
      }
      const existing = actors.get(existingId);
      if (!existing) {
        throw new Error('Project ActivityPub actor was not found.');
      }
      existing.actor = { ...existing.actor, enabled: false, updatedAt: new Date() };
      return existing.actor;
    },
    async findRemotelyVisibleActorByUsername(preferredUsername) {
      const actorId = actorsByUsername.get(preferredUsername);
      if (!actorId) {
        return undefined;
      }
      const entry = actors.get(actorId);
      if (!entry?.actor.enabled) {
        return undefined;
      }
      if (entry.actor.kind === 'aggregate') {
        return entry.actor;
      }
      const project = entry.actor.projectId ? projects.get(entry.actor.projectId) : undefined;
      if (project?.visibility !== 'public') {
        return undefined;
      }
      return entry.actor;
    },
    async importActorCryptoKeyPair(
      actorId,
    ): Promise<Awaited<ReturnType<typeof generateCryptoKeyPair>>> {
      const entry = actors.get(actorId);
      if (!entry) {
        throw new Error('ActivityPub actor was not found.');
      }
      const privateJwk = decryptPrivateJwk({
        encrypted: entry.encryptedPrivateKey,
        encryptionKey: input.encryptionKey,
      });
      const publicJwk = await importSpkiToJwk(entry.actor.publicKeyPem);
      const [privateKey, publicKey] = await Promise.all([
        importJwk(privateJwk, 'private'),
        importJwk(publicJwk, 'public'),
      ]);
      return { privateKey, publicKey };
    },
    async findPublicReportArticle(reportId) {
      const report = reports.get(reportId);
      if (!report) {
        return undefined;
      }
      const actor = await repository.findRemotelyVisibleActorByUsername(report.preferredUsername);
      if (!actor || actor.projectId !== report.projectId || !actor.enabled) {
        return undefined;
      }
      const project = projects.get(report.projectId);
      if (project?.visibility !== 'public') {
        return undefined;
      }
      return report;
    },
    async getInstanceConfig() {
      return instanceConfig;
    },
    async updateInstanceRepresentation(objectRepresentation) {
      if (instanceConfig.representationLockedAt !== null) {
        throw new Error('ActivityPub object representation is locked');
      }
      instanceConfig = {
        ...instanceConfig,
        objectRepresentation,
        updatedAt: new Date(),
      };
      return instanceConfig;
    },
    async seedAggregateActor() {
      return seedAggregateActorInternal();
    },
    seedProject(project) {
      projects.set(project.id, project);
    },
    async seedProjectActor(actor) {
      projects.set(actor.projectId, {
        id: actor.projectId,
        slug: actor.projectSlug,
        name: actor.projectName ?? actor.projectSlug,
        visibility: actor.visibility,
      });
      return seedProjectActorInternal(actor);
    },
    seedPublicReport(report) {
      reports.set(report.reportId, report);
    },
    setProjectVisibility(projectId, visibility) {
      const project = projects.get(projectId);
      if (project) {
        projects.set(projectId, { ...project, visibility });
      }
    },
    setInstanceObjectRepresentation(objectRepresentation) {
      instanceConfig = {
        ...instanceConfig,
        objectRepresentation,
        updatedAt: new Date(),
      };
    },
  };

  function lockProjectScope(projectId: string, projectSlug: string): ProjectRecord {
    const project = projects.get(projectId);
    if (!project || project.slug !== projectSlug) {
      throw new Error('Project scope mismatch');
    }
    return project;
  }

  async function seedProjectActorInternal(actor: {
    projectId: string;
    projectSlug: string;
    projectName?: string;
    preferredUsername: string;
    visibility: 'public' | 'private';
    enabled: boolean;
  }): Promise<ActivityPubActor> {
    projects.set(actor.projectId, {
      id: actor.projectId,
      slug: actor.projectSlug,
      name: actor.projectName ?? actor.projectSlug,
      visibility: actor.visibility,
    });
    const keyMaterial = await createActorKeyMaterial(input.encryptionKey);
    const id = crypto.randomUUID();
    const created: ActivityPubActor = {
      id,
      projectId: actor.projectId,
      kind: 'project',
      preferredUsername: actor.preferredUsername,
      displayName: actor.projectName ?? actor.projectSlug,
      enabled: actor.enabled,
      publicKeyPem: keyMaterial.publicKeyPem,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    actors.set(id, { actor: created, encryptedPrivateKey: keyMaterial.encryptedPrivateKey });
    actorsByUsername.set(created.preferredUsername, id);
    actorsByProjectId.set(actor.projectId, id);
    return created;
  }

  async function seedAggregateActorInternal(): Promise<ActivityPubActor> {
    const keyMaterial = await createActorKeyMaterial(input.encryptionKey);
    const id = crypto.randomUUID();
    const created: ActivityPubActor = {
      id,
      projectId: null,
      kind: 'aggregate',
      preferredUsername: 'all',
      displayName: 'All Projects',
      enabled: true,
      publicKeyPem: keyMaterial.publicKeyPem,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    actors.set(id, { actor: created, encryptedPrivateKey: keyMaterial.encryptedPrivateKey });
    actorsByUsername.set('all', id);
    return created;
  }

  return repository;
}

async function createActorKeyMaterial(encryptionKey: Buffer) {
  const keyPair = await generateCryptoKeyPair('RSASSA-PKCS1-v1_5');
  const [publicKeyPem, privateJwk] = await Promise.all([
    exportSpki(keyPair.publicKey),
    exportJwk(keyPair.privateKey),
  ]);
  return {
    publicKeyPem,
    encryptedPrivateKey: encryptPrivateJwk({ privateJwk, encryptionKey }),
  };
}

async function importSpkiToJwk(publicKeyPem: string) {
  const pemBody = publicKeyPem
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replaceAll('\n', '')
    .trim();
  const der = Buffer.from(pemBody, 'base64');
  const key = await crypto.subtle.importKey(
    'spki',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    true,
    ['verify'],
  );
  return exportJwk(key);
}
