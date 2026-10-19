// apps/skill-vault/src/index.ts — public library surface of @aik/skill-vault.
export { vaultConfigSchema, loadConfig, saveConfig, type VaultConfig } from './config.ts';
export { VaultDb, SKILL_STATUSES, type SkillRow, type SkillStatus } from './db.ts';
export { HttpError, PoliteHttpClient, SizeCapError, type FetchLike } from './http.ts';
export { McpClient, McpError } from './mcp.ts';
export { SkillsmpClient, isCodingCategory, looksLikeCodingSkill, type CategoryInfo, type SearchPage, type SkillSearchItem } from './skillsmp.ts';
export { exportCatalogCsv, runDiscovery, upsertDiscoveredSkill, parseGithubUrl, parseSkillUrl } from './catalog.ts';
export { runDownload, findSkillDirs, type DownloadOptions, type DownloadResult, type DownloadTargets } from './download.ts';
export { extractTarGz, UnsafeArchiveError, validateEntryName, type ExtractResult, type TarLimits } from './tar.ts';
export { GithubResolver, detectLicense, codeloadTarballUrl, type RepoHead } from './github.ts';
export {
  runScan,
  scanSkillContent,
  effectiveFindings,
  dismissFinding,
  parseFrontmatter,
  writeSecurityReport,
  type RawFinding,
  type ScanOutcome,
  type Severity,
} from './scanner.ts';
export { searchSkills, skillStats, duplicateGroups, type SearchFilters, type SearchHit } from './search.ts';
export { inspectRepo, searchTermsForRepo, type RepoInspection } from './repo-inspect.ts';
export { recommendForRepo, type RecommendResult, type Recommendation } from './recommend.ts';
export {
  AGENT_SPECS,
  detectAgent,
  installSkills,
  integrationStatus,
  uninstallSkill,
  validateSkillForAgent,
  type AgentId,
  type InstallReport,
} from './integrations.ts';
export { buildApplyPlan, type ApplyPlan } from './apply.ts';
export { collectStatus, writeDownloadReport, writeIntegrationReport, formatBytes, type VaultStatus } from './report.ts';
export { verifyVault, type VerifyResult } from './verify.ts';
export { backupVault, restoreVault, type BackupResult } from './backup.ts';
export { defaultVaultRoot, resolveVaultRoot, vaultPaths, ensureVaultLayout, skillDirFor, skillDirSlug, type VaultPaths } from './paths.ts';
export { redact, Logger } from './log.ts';
