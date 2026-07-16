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

/**
 * Creates the repository and storage configuration required to fetch reports.
 *
 * @returns A report fetch context containing configured repository and storage options.
 */
export function createReportFetchContext(): ReportFetchContext {
  return {
    options: {
      repository: createPostgresReportRepository(getRequiredAdminSql()),
      storage: createReportStorageFromEnv(),
    },
  };
}

/**
 * Creates an HTTP response that downloads a report PDF.
 *
 * @param pdf - The PDF file data and download filename
 * @returns An HTTP response containing the PDF bytes with download headers
 */
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
