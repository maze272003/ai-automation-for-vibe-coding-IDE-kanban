// apps/ui/src/routes/usage.tsx
import { UsageDashboard } from '../components/UsageDashboard.tsx';

export function UsagePage() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <UsageDashboard />
    </div>
  );
}
