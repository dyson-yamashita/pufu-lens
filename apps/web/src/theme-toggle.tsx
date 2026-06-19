'use client';

import { Moon, Sun } from 'lucide-react';
import { useState } from 'react';
import { type Theme, themeCookieName } from './theme';

const maxAgeSeconds = 60 * 60 * 24 * 365;

function persistTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  // biome-ignore lint/suspicious/noDocumentCookie: Cookie を用いてテーマ設定を永続化する。
  document.cookie = `${themeCookieName}=${theme}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`;
}

export function ThemeToggle({ initialTheme = 'dark' }: { readonly initialTheme?: Theme }) {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const nextTheme: Theme = theme === 'dark' ? 'light' : 'dark';

  const selectTheme = (nextTheme: Theme) => {
    setTheme(nextTheme);
    persistTheme(nextTheme);
  };
  const label =
    theme === 'dark'
      ? '現在はダークテーマです。ライトテーマに切り替える'
      : '現在はライトテーマです。ダークテーマに切り替える';

  return (
    <span className="theme-toggle" data-testid="theme-toggle">
      <button
        aria-label={label}
        className="theme-toggle-button"
        data-testid="theme-toggle-button"
        onClick={() => selectTheme(nextTheme)}
        title={label}
        type="button"
      >
        {theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
      </button>
    </span>
  );
}
