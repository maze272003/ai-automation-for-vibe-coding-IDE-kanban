// apps/desktop/scripts/apply-fuses.ts
// Configures and applies hardened Electron fuses to the packaged binary (REL-6).

export interface ElectronFusesConfig {
  runAsNode: boolean;
  enableCookieEncryption: boolean;
  enableNodeOptionsEnvironmentVariable: boolean;
  enableNodeCliInspectArguments: boolean;
  enableEmbeddedAsarIntegrityValidation: boolean;
  onlyLoadAppFromAsar: boolean;
}

export const REQUIRED_FUSES: ElectronFusesConfig = {
  runAsNode: false,
  enableCookieEncryption: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
};

interface FusesModule {
  flipFuses: (path: string, options: Record<string, unknown>) => Promise<void>;
  FuseVersion: { V1: string };
  FuseV1Options: {
    RunAsNode: string;
    EnableCookieEncryption: string;
    EnableNodeOptionsEnvironmentVariable: string;
    EnableNodeCliInspectArguments: string;
    EnableEmbeddedAsarIntegrityValidation: string;
    OnlyLoadAppFromAsar: string;
  };
}

export async function applyElectronFuses(executablePath: string, options: Partial<ElectronFusesConfig> = {}) {
  try {
    // Dynamically imported when executed in an environment with @electron/fuses installed
    const fusesPkg = '@electron/fuses';
    const { flipFuses, FuseVersion, FuseV1Options } = (await import(fusesPkg)) as FusesModule;
    await flipFuses(executablePath, {
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: options.runAsNode ?? REQUIRED_FUSES.runAsNode,
      [FuseV1Options.EnableCookieEncryption]: options.enableCookieEncryption ?? REQUIRED_FUSES.enableCookieEncryption,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]:
        options.enableNodeOptionsEnvironmentVariable ?? REQUIRED_FUSES.enableNodeOptionsEnvironmentVariable,
      [FuseV1Options.EnableNodeCliInspectArguments]:
        options.enableNodeCliInspectArguments ?? REQUIRED_FUSES.enableNodeCliInspectArguments,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]:
        options.enableEmbeddedAsarIntegrityValidation ?? REQUIRED_FUSES.enableEmbeddedAsarIntegrityValidation,
      [FuseV1Options.OnlyLoadAppFromAsar]: options.onlyLoadAppFromAsar ?? REQUIRED_FUSES.onlyLoadAppFromAsar,
    });
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
