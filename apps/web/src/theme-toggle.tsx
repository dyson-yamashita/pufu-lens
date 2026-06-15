'use client';

import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

type Theme = 'dark' | 'light';

const cookieName = 'pufu-lens-theme';
const maxAgeSeconds = 60 * 60 * 24 * 365;

function normalizeTheme(value: string | undefined): Theme {
  return value === 'light' || value === 'dark' ? value : 'dark';
}

async function persistTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  if ('cookieStore' in window) {
    await window.cookieStore.set({
      expires: Date.now() + maxAgeSeconds * 1000,
      name: cookieName,
      path: '/',
      sameSite: 'lax',
      value: theme,
    });
    return;
  }

  // biome-ignore lint/suspicious/noDocumentCookie: Cookie Store API 非対応ブラウザ向けの永続化 fallback。
  document.cookie = `${cookieName}=${theme}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`;
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    setTheme(normalizeTheme(document.documentElement.dataset.theme));
  }, []);

  const selectTheme = (nextTheme: Theme) => {
    setTheme(nextTheme);
    void persistTheme(nextTheme);
  };

  return (
    <fieldset className="theme-toggle" data-testid="theme-toggle">
      <legend className="theme-toggle-label">テーマ切替</legend>
      <button
        aria-label="ライトテーマに切り替える"
        aria-pressed={theme === 'light'}
        className={theme === 'light' ? 'theme-toggle-option active' : 'theme-toggle-option'}
        data-testid="theme-toggle-light"
        onClick={() => selectTheme('light')}
        title="Light"
        type="button"
      >
        <Sun size={16} />
      </button>
      <button
        aria-label="ダークテーマに切り替える"
        aria-pressed={theme === 'dark'}
        className={theme === 'dark' ? 'theme-toggle-option active' : 'theme-toggle-option'}
        data-testid="theme-toggle-dark"
        onClick={() => selectTheme('dark')}
        title="Dark"
        type="button"
      >
        <Moon size={16} />
      </button>
    </fieldset>
  );
}
