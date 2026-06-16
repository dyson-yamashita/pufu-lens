export type Theme = 'dark' | 'light';

export const themeCookieName = 'pufu-lens-theme';

export function normalizeTheme(value: string | undefined): Theme {
  return value === 'light' || value === 'dark' ? value : 'dark';
}
