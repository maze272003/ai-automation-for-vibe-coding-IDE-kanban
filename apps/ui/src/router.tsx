import { createHashHistory, createRootRoute, createRoute, createRouter, lazyRouteComponent } from '@tanstack/react-router';
import { BoardPage } from './routes/board.tsx';
import { DashboardPage } from './routes/dashboard.tsx';
import { GitPage } from './routes/git-page.tsx';
import { OfficePage } from './routes/office.tsx';
import { RootLayout } from './routes/root.tsx';
import { SettingsPage } from './routes/settings.tsx';
import { UsagePage } from './routes/usage.tsx';

const rootRoute = createRootRoute({ component: RootLayout });
const CodePage = lazyRouteComponent(() => import('./routes/code-page.tsx'), 'CodePage');
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

export const router = createRouter({
  routeTree: rootRoute.addChildren([dashboardRoute, boardRoute, codeRoute, gitRoute, usageRoute, settingsRoute, officeRoute]),
  history: createHashHistory(),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
