import { NextResponse } from 'next/server';
import type { ObjectStorage } from '../../../packages/storage/src/object-storage.ts';
import { getRequiredAdminSql } from './admin-sql';
import { businessHoursFromEnv, isWithinBusinessHours } from './chat';
import {
  createPostgresReportRepository,
  createReportStorageFromEnv,
  type ReportAccessOptions,
  reportNowFromEnv,
} from './report';
import type { ReportPdfFile } from './report-pdf';

export type ReportFetchContext = {
  readonly businessHours: ReturnType<typeof businessHoursFromEnv>;
  readonly now: Date;
  readonly options: ReportAccessOptions & { readonly storage: ObjectStorage };
};

export function createReportFetchContext(): ReportFetchContext {
  const businessHours = businessHoursFromEnv(process.env);
  const now = reportNowFromEnv(process.env) ?? new Date();
  return {
    businessHours,
    now,
    options: {
      businessHours,
      now,
      repository: createPostgresReportRepository(getRequiredAdminSql()),
      storage: createReportStorageFromEnv(),
    },
  };
}

export function isOutsideReportBusinessHours(context: ReportFetchContext): boolean {
  return !isWithinBusinessHours(context.now, context.businessHours);
}

export function reportOutsideBusinessHoursResponse() {
  return NextResponse.json({ report: null, status: 'db_outside_business_hours' }, { status: 503 });
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
