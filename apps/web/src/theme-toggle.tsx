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

  const selectTheme = (nextTheme: Theme) => {
    setTheme(nextTheme);
    persistTheme(nextTheme);
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
