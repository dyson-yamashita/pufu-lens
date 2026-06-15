import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import '../src/styles.css';

export const metadata: Metadata = {
  title: 'Pufu Lens',
  description: 'Project ingestion operations console',
};

type Theme = 'dark' | 'light';

function normalizeTheme(value: string | undefined): Theme {
  return value === 'light' || value === 'dark' ? value : 'dark';
}

export default async function RootLayout({ children }: { readonly children: React.ReactNode }) {
  const cookieStore = await cookies();
  const theme = normalizeTheme(cookieStore.get('pufu-lens-theme')?.value);

  return (
    <html lang="ja" data-theme={theme}>
      <body>{children}</body>
    </html>
  );
}
