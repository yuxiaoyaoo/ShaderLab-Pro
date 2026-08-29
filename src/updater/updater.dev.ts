import { openUpdaterDevSimulation, type UpdaterSimulationKind } from './updater';

export const UPDATER_DEV_SENTINEL = 'SLP_UPDATER_DEV_SIMULATION';

export function installUpdaterDevApi(target: Record<string, unknown>): void {
  if (!import.meta.env.DEV) return;
  const open = async (kind: UpdaterSimulationKind) => {
    openUpdaterDevSimulation(kind);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    return UPDATER_DEV_SENTINEL;
  };
  target.updater = {
    prompt: () => open('prompt'),
    failed: () => open('failed'),
    ready: () => open('ready'),
  };
}
