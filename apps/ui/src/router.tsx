import { createHashHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { BoardPage } from './routes/board.tsx';
import { DashboardPage } from './routes/dashboard.tsx';
import { RootLayout } from './routes/root.tsx';
import { SettingsPage } from './routes/settings.tsx';

const rootRoute = createRootRoute({ component: RootLayout });
const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: DashboardPage });
const boardRoute = createRoute({ getParentRoute: () => rootRoute, path: '/projects/$projectId', component: BoardPage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage });

export const router = createRouter({
  routeTree: rootRoute.addChildren([dashboardRoute, boardRoute, settingsRoute]),
  history: createHashHistory(),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
