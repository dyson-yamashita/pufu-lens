'use client';

import { Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';

type Theme = 'dark' | 'light';

const cookieName = 'pufu-lens-theme';
const maxAgeSeconds = 60 * 60 * 24 * 365;

function normalizeTheme(value: string | undefined): Theme {
  return value === 'light' || value === 'dark' ? value : 'dark';
}

function persistTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.cookie = `${cookieName}=${theme}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`;
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>('dark');

  useEffect(() => {
    setTheme(normalizeTheme(document.documentElement.dataset.theme));
  }, []);

  const selectTheme = (nextTheme: Theme) => {
    setTheme(nextTheme);
    persistTheme(nextTheme);
  };

  return (
    <div className="theme-toggle" data-testid="theme-toggle" role="group" aria-label="テーマ切替">
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
    </div>
  );
}
