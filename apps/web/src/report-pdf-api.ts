import { NextResponse } from 'next/server';
import type { ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import { getRequiredAdminSql } from './admin-sql';
import {
  createPostgresReportRepository,
  createReportStorageFromEnv,
  type ReportAccessOptions,
} from './report';
import type { ReportPdfFile } from './report-pdf';

export type ReportFetchContext = {
  readonly options: ReportAccessOptions & { readonly storage: ObjectStorage };
};

export function createReportFetchContext(): ReportFetchContext {
  return {
    options: {
      repository: createPostgresReportRepository(getRequiredAdminSql()),
      storage: createReportStorageFromEnv(),
    },
  };
}

export function createReportPdfDownloadResponse(pdf: ReportPdfFile): NextResponse {
  return new NextResponse(pdf.bytes, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${pdf.fileName}"`,
      'Content-Type': 'application/pdf',
    },
    status: 200,
  });
}
