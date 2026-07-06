import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { normalizeTheme, themeCookieName } from '../src/theme';
import '../src/styles.css';
import '../src/styles-project.css';
import '../src/styles-admin.css';

export const metadata: Metadata = {
  title: 'Pufu Lens',
  description: 'Project ingestion operations console',
  icons: {
    icon: [
      { url: '/favicon.ico' },
      { url: '/favicon-16x16.png', sizes: '16x16', type: 'image/png' },
      { url: '/favicon-32x32.png', sizes: '32x32', type: 'image/png' },
    ],
    apple: [{ url: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export default async function RootLayout({ children }: { readonly children: React.ReactNode }) {
  const cookieStore = await cookies();
  const theme = normalizeTheme(cookieStore.get(themeCookieName)?.value);

  return (
    <html lang="ja" data-theme={theme}>
      <body>{children}</body>
    </html>
  );
}
