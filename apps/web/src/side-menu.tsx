'use client';

import { Menu, X } from 'lucide-react';
import Image from 'next/image';
import { useEffect, useId, useState } from 'react';
import type { Theme } from './theme';
import { ThemeToggle } from './theme-toggle';

const mobileMenuQuery = '(max-width: 720px)';

export function SideMenu({
  children,
  initialTheme,
  menuTestId,
  navTestId,
  toggleTestId,
}: {
  readonly children: React.ReactNode;
  readonly initialTheme: Theme;
  readonly menuTestId: string;
  readonly navTestId: string;
  readonly toggleTestId: string;
}) {
  const contentId = useId();
  const [isOpen, setIsOpen] = useState(true);

  useEffect(() => {
    const mediaQuery = window.matchMedia(mobileMenuQuery);
    const syncMenuState = () => setIsOpen(!mediaQuery.matches);

    syncMenuState();
    mediaQuery.addEventListener('change', syncMenuState);

    return () => mediaQuery.removeEventListener('change', syncMenuState);
  }, []);

  return (
    <div className="guest-menu" data-open={isOpen ? 'true' : 'false'} data-testid={menuTestId}>
      <button
        aria-controls={contentId}
        aria-expanded={isOpen}
        className="guest-menu-toggle"
        data-testid={toggleTestId}
        type="button"
        onClick={() => setIsOpen((current) => !current)}
      >
        <Menu className="guest-menu-open-icon" size={22} />
        <X className="guest-menu-close-icon" size={22} />
        <Image
          alt="Pufu Lens"
          className="brand-logo"
          height={40}
          src="/pufu-lens-logo.png"
          width={40}
        />
        <strong className="guest-brand-name">Pufu Lens</strong>
      </button>
      <div className="guest-menu-content" id={contentId}>
        <div className="guest-menu-content-inner">
          <ThemeToggle initialTheme={initialTheme} />
          <nav aria-label="Primary" className="guest-side-menu" data-testid={navTestId}>
            {children}
          </nav>
        </div>
      </div>
    </div>
  );
}
