import { createHashHistory, createRootRoute, createRoute, createRouter, lazyRouteComponent } from '@tanstack/react-router';
import { BoardPage } from './routes/board.tsx';
import { DashboardPage } from './routes/dashboard.tsx';
import { GitPage } from './routes/git-page.tsx';
import { RootLayout } from './routes/root.tsx';
import { SettingsPage } from './routes/settings.tsx';
import { UsagePage } from './routes/usage.tsx';

const rootRoute = createRootRoute({ component: RootLayout });
const OfficePage = lazyRouteComponent(() => import('./routes/office.tsx'), 'OfficePage');
const CodePage = lazyRouteComponent(() => import('./routes/code-page.tsx'), 'CodePage');
const ProjectSettingsPage = lazyRouteComponent(() => import('./routes/project-settings.tsx'), 'ProjectSettingsPage');
const DiagnosticsPage = lazyRouteComponent(() => import('./routes/diagnostics.tsx'), 'DiagnosticsPage');
const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: DashboardPage });
const boardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId',
  component: BoardPage,
  validateSearch: (search: Record<string, unknown>): { terminal?: string } =>
    typeof search.terminal === 'string' && search.terminal !== '' ? { terminal: search.terminal } : {},
});
const codeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/projects/$projectId/code', component: CodePage });
const gitRoute = createRoute({ getParentRoute: () => rootRoute, path: '/projects/$projectId/git', component: GitPage });
const usageRoute = createRoute({ getParentRoute: () => rootRoute, path: '/usage', component: UsagePage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage });
const officeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/office', component: OfficePage });
const diagnosticsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/diagnostics', component: DiagnosticsPage });
const projectSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId/settings',
  component: ProjectSettingsPage,
  validateSearch: (search: Record<string, unknown>): { section?: 'verification' } => search.section === 'verification' ? { section: 'verification' } : {},
});

export const router = createRouter({
  routeTree: rootRoute.addChildren([dashboardRoute, boardRoute, codeRoute, gitRoute, usageRoute, settingsRoute, officeRoute, projectSettingsRoute, diagnosticsRoute]),
  history: createHashHistory(),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
