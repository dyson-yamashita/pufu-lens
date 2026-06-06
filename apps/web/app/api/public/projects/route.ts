import { NextResponse } from 'next/server';
import { listPublicProjects } from '../../../../src/admin-db';

export async function GET() {
  const projects = await listPublicProjects();
  return NextResponse.json({ projects, status: 'ok' });
}
