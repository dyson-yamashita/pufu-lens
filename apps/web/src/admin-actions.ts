'use server';

import { mergeActors as mergeActorsAction } from './admin-actor-actions.ts';
import {
  collectAndIngestDataSource as collectAndIngestDataSourceAction,
  collectDataSource as collectDataSourceAction,
  createDataSource as createDataSourceAction,
  deleteDataSource as deleteDataSourceAction,
  ingestDataSource as ingestDataSourceAction,
  retryFailedQueue as retryFailedQueueAction,
  updateDataSource as updateDataSourceAction,
} from './admin-data-source-actions.ts';
import {
  addProjectMember as addProjectMemberAction,
  createMember as createMemberAction,
  removeProjectMember as removeProjectMemberAction,
  updateMember as updateMemberAction,
} from './admin-member-actions.ts';
import {
  approveParserVersion as approveParserVersionAction,
  rejectParserVersion as rejectParserVersionAction,
} from './admin-parser-actions.ts';
import {
  createProject as createProjectAction,
  updateGithubAppConnectionSettings as updateGithubAppConnectionSettingsAction,
  updateProjectSettings as updateProjectSettingsAction,
  updateProjectVisibility as updateProjectVisibilityAction,
} from './admin-project-actions.ts';
import { generatePrivateReport as generatePrivateReportAction } from './admin-report-actions.ts';

export async function createProject(formData: FormData): Promise<void> {
  await createProjectAction(formData);
}

export async function updateProjectVisibility(formData: FormData): Promise<void> {
  await updateProjectVisibilityAction(formData);
}

export async function updateProjectSettings(formData: FormData): Promise<void> {
  await updateProjectSettingsAction(formData);
}

export async function updateGithubAppConnectionSettings(formData: FormData): Promise<void> {
  await updateGithubAppConnectionSettingsAction(formData);
}

export async function mergeActors(formData: FormData): Promise<void> {
  await mergeActorsAction(formData);
}

export async function createMember(formData: FormData): Promise<void> {
  await createMemberAction(formData);
}

export async function updateMember(formData: FormData): Promise<void> {
  await updateMemberAction(formData);
}

export async function addProjectMember(formData: FormData): Promise<void> {
  await addProjectMemberAction(formData);
}

export async function removeProjectMember(formData: FormData): Promise<void> {
  await removeProjectMemberAction(formData);
}

export async function createDataSource(formData: FormData): Promise<void> {
  await createDataSourceAction(formData);
}

export async function updateDataSource(formData: FormData): Promise<void> {
  await updateDataSourceAction(formData);
}

export async function deleteDataSource(formData: FormData): Promise<void> {
  await deleteDataSourceAction(formData);
}

export async function retryFailedQueue(formData: FormData): Promise<void> {
  await retryFailedQueueAction(formData);
}

export async function collectDataSource(formData: FormData): Promise<void> {
  await collectDataSourceAction(formData);
}

export async function collectAndIngestDataSource(formData: FormData): Promise<void> {
  await collectAndIngestDataSourceAction(formData);
}

export async function ingestDataSource(formData: FormData): Promise<void> {
  await ingestDataSourceAction(formData);
}

export async function generatePrivateReport(formData: FormData): Promise<void> {
  await generatePrivateReportAction(formData);
}

export async function approveParserVersion(formData: FormData): Promise<void> {
  await approveParserVersionAction(formData);
}

export async function rejectParserVersion(formData: FormData): Promise<void> {
  await rejectParserVersionAction(formData);
}
