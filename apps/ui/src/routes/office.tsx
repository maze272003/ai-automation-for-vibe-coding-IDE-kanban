import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import type { AppSettings } from '@aik/contracts';
import { TopBar } from '../components/shell/top-bar.tsx';
import { isOfficeEnabled, toOfficeBounds } from '../lib/office.ts';

/**
 * The office itself renders in a main-process WebContentsView layered over this container
 * (an iframe would be mixed content under app://). This page owns: the feature off state,
 * the loading state, and reporting the container's bounds so main can position the view.
 */
export function OfficePage() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.api.getAppSettings().then(setSettings, () => setSettings(null));
  }, []);

  const enabled = isOfficeEnabled(settings);

  useEffect(() => {
    if (!enabled) return;
    const report = () => {
      const el = ref.current;
      if (el) window.api.office.setBounds(toOfficeBounds(el.getBoundingClientRect()));
    };
    report();
    window.api.office.setVisible(true);
    const onResize = () => report();
    window.addEventListener('resize', onResize);
    const el = ref.current;
    const observer = el ? new ResizeObserver(report) : null;
    if (el && observer) observer.observe(el);
    return () => {
      window.removeEventListener('resize', onResize);
      observer?.disconnect();
      window.api.office.setVisible(false);
    };
  }, [enabled]);

  return (
    <div className="flex h-full flex-col">
      <TopBar title="Agent office" subtitle="Every running agent as a pixel-art character" />
      <div className="min-h-0 flex-1 p-4">
        {settings === null ? (
          <p data-testid="office-loading" className="text-sm text-muted">Loading…</p>
        ) : enabled ? (
          <div
            data-testid="office-viewport"
            ref={ref}
            aria-label="Agent office viewport (rendered natively by the app)"
            className="h-full w-full rounded-panel border border-glass-border bg-surface-2"
          />
        ) : (
          <p data-testid="office-disabled" className="rounded-panel border border-dashed border-glass-border bg-glass/40 p-6 text-sm text-muted">
            The agent office is turned off. Enable it in{' '}
            <Link to="/settings" className="font-semibold text-foreground underline">
              Settings
            </Link>
            .
          </p>
        )}
      </div>
    </div>
  );
}
