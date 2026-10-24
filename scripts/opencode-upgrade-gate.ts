// scripts/opencode-upgrade-gate.ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

export interface OpenApiSchema {
  openapi?: string;
  info?: { title?: string; version?: string };
  paths?: Record<
    string,
    Record<
      string,
      {
        operationId?: string;
        summary?: string;
        parameters?: Array<{ name: string; in: string; required?: boolean }>;
        requestBody?: {
          required?: boolean;
          content?: Record<string, { schema?: Record<string, unknown> }>;
        };
        responses?: Record<string, unknown>;
      }
    >
  >;
  components?: unknown;
}

export interface GateDiffResult {
  compatible: boolean;
  breakingChanges: string[];
  warnings: string[];
  summary: {
    requiredOperationsTotal: number;
    requiredOperationsFound: number;
    breakingChangesCount: number;
  };
}

export interface RequiredOperation {
  key: string;
  method: string;
  pathPattern: RegExp;
  description: string;
}

export const REQUIRED_OPERATIONS: RequiredOperation[] = [
  {
    key: 'session.create',
    method: 'post',
    pathPattern: /^\/(?:api\/)?session\/?$/i,
    description: 'POST /api/session (session creation)',
  },
  {
    key: 'session.active',
    method: 'get',
    pathPattern: /^\/(?:api\/)?session\/active\/?$/i,
    description: 'GET /api/session/active (active session polling)',
  },
  {
    key: 'session.remove',
    method: 'delete',
    pathPattern: /^\/(?:api\/)?session\/\{[^}]+\}\/?$/i,
    description: 'DELETE /api/session/{id} (session cleanup)',
  },
  {
    key: 'session.prompt',
    method: 'post',
    pathPattern: /^\/(?:api\/)?session\/\{[^}]+\}\/prompt\/?$/i,
    description: 'POST /api/session/{id}/prompt (send user/system prompt)',
  },
  {
    key: 'session.message.list',
    method: 'get',
    pathPattern: /^\/(?:api\/)?session\/\{[^}]+\}\/message\/?$/i,
    description: 'GET /api/session/{id}/message (retrieve message history)',
  },
  {
    key: 'session.interrupt',
    method: 'post',
    pathPattern: /^\/(?:api\/)?session\/\{[^}]+\}\/(?:interrupt|abort)\/?$/i,
    description: 'POST /api/session/{id}/interrupt (interrupt running session)',
  },
];

export function verifyOpenCodeSchema(candidateSpec: OpenApiSchema): GateDiffResult {
  const breakingChanges: string[] = [];
  const warnings: string[] = [];
  let foundCount = 0;

  const paths = candidateSpec.paths ?? {};
  const pathKeys = Object.keys(paths);

  for (const op of REQUIRED_OPERATIONS) {
    const matchingPath = pathKeys.find((p) => op.pathPattern.test(p));
    if (!matchingPath) {
      breakingChanges.push(`Missing required endpoint: ${op.description}`);
      continue;
    }

    const pathItem = paths[matchingPath];
    const methodItem = pathItem ? pathItem[op.method.toLowerCase()] : undefined;

    if (!methodItem) {
      breakingChanges.push(`Missing required HTTP method ${op.method.toUpperCase()} on ${matchingPath} for ${op.key}`);
      continue;
    }

    // Verify no newly added mandatory query/header parameters that would break existing calls
    if (Array.isArray(methodItem.parameters)) {
      for (const param of methodItem.parameters) {
        if (param.required && (param.in === 'query' || param.in === 'header')) {
          breakingChanges.push(
            `Endpoint ${matchingPath} requires new mandatory ${param.in} parameter '${param.name}'`,
          );
        }
      }
    }

    foundCount++;
  }

  // Detect non-breaking additions for reporting
  for (const p of pathKeys) {
    if (!REQUIRED_OPERATIONS.some((op) => op.pathPattern.test(p))) {
      warnings.push(`Candidate spec contains additional/extended endpoint: ${p}`);
    }
  }

  const compatible = breakingChanges.length === 0;

  return {
    compatible,
    breakingChanges,
    warnings,
    summary: {
      requiredOperationsTotal: REQUIRED_OPERATIONS.length,
      requiredOperationsFound: foundCount,
      breakingChangesCount: breakingChanges.length,
    },
  };
}

export function formatDiffReport(result: GateDiffResult): string {
  const statusLine = result.compatible
    ? 'Status: PASSED (Fully Compatible)'
    : 'Status: FAILED (Breaking Changes Detected)';

  const lines = [
    '=================================================================',
    '                OpenCode Upgrade Gate Report                     ',
    '=================================================================',
    statusLine,
    `Required Operations: ${result.summary.requiredOperationsFound} / ${result.summary.requiredOperationsTotal} satisfied`,
    `Breaking Changes:    ${result.summary.breakingChangesCount}`,
    '-----------------------------------------------------------------',
  ];

  if (result.breakingChanges.length > 0) {
    lines.push('Breaking Changes:');
    for (const change of result.breakingChanges) {
      lines.push(`  [FAIL] ${change}`);
    }
  }

  if (result.warnings.length > 0) {
    lines.push('Non-Breaking Additions / Warnings:');
    for (const warn of result.warnings.slice(0, 5)) {
      lines.push(`  [INFO] ${warn}`);
    }
    if (result.warnings.length > 5) {
      lines.push(`  ... and ${result.warnings.length - 5} more additional endpoints`);
    }
  }

  lines.push('=================================================================');
  return lines.join('\n');
}

export function runContractsSuite(): { success: boolean; output: string } {
  try {
    const output = execSync('npx vitest run packages/contracts/test/opencode.test.ts', {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    return { success: true, output };
  } catch (err: unknown) {
    const execErr = err as { stdout?: string; message?: string };
    return { success: false, output: execErr.stdout ? String(execErr.stdout) : String(err) };
  }
}

// Entrypoint when executed directly via node CLI
const isDirectCli = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectCli) {
  let specPath: string;
  const specArgIdx = process.argv.indexOf('--spec');

  if (specArgIdx !== -1 && process.argv[specArgIdx + 1]) {
    specPath = path.resolve(process.argv[specArgIdx + 1]!);
  } else {
    // Default baseline specification path
    specPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../packages/contracts/resources/opencode-baseline.json',
    );
  }

  if (!fs.existsSync(specPath)) {
    console.error(`[gate:opencode] Specification file not found: ${specPath}`);
    process.exit(1);
  }

  const rawJson = fs.readFileSync(specPath, 'utf8');
  let candidateSpec: OpenApiSchema;
  try {
    candidateSpec = JSON.parse(rawJson);
  } catch (err) {
    console.error(`[gate:opencode] Failed to parse JSON specification at ${specPath}:`, err);
    process.exit(1);
  }

  console.log(`[gate:opencode] Verifying OpenCode schema: ${specPath}`);
  const result = verifyOpenCodeSchema(candidateSpec);
  console.log(formatDiffReport(result));

  console.log('\n[gate:opencode] Running contracts test suite...');
  const testRun = runContractsSuite();

  if (!testRun.success) {
    console.error('[gate:opencode] Contracts test suite FAILED:');
    console.error(testRun.output);
    process.exit(1);
  }

  console.log('[gate:opencode] Contracts test suite PASSED.');

  if (!result.compatible) {
    process.exit(1);
  }

  console.log('\n[gate:opencode] All checks passed successfully.');
  process.exit(0);
}
