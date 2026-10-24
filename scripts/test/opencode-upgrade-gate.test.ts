// scripts/test/opencode-upgrade-gate.test.ts
import { describe, expect, test } from 'vitest';
import {
  formatDiffReport,
  verifyOpenCodeSchema,
  type OpenApiSchema,
} from '../opencode-upgrade-gate.ts';

const VALID_BASELINE_SPEC: OpenApiSchema = {
  openapi: '3.1.0',
  info: { title: 'OpenCode', version: '2.0.32' },
  paths: {
    '/api/session': {
      post: {
        operationId: 'session.create',
        summary: 'Create session',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  model: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    '/api/session/active': {
      get: {
        operationId: 'session.active',
        summary: 'Active sessions',
      },
    },
    '/api/session/{sessionID}': {
      delete: {
        operationId: 'session.remove',
        summary: 'Delete session',
      },
    },
    '/api/session/{sessionID}/prompt': {
      post: {
        operationId: 'session.prompt',
        summary: 'Send prompt',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
    '/api/session/{sessionID}/message': {
      get: {
        operationId: 'session.message.list',
        summary: 'List messages',
      },
    },
    '/api/session/{sessionID}/interrupt': {
      post: {
        operationId: 'session.interrupt',
        summary: 'Interrupt session',
      },
    },
  },
};

describe('REL-8 OpenCode Upgrade Gate', () => {
  test('passes validation for fully compatible schema', () => {
    const result = verifyOpenCodeSchema(VALID_BASELINE_SPEC);
    expect(result.compatible).toBe(true);
    expect(result.breakingChanges).toHaveLength(0);
    expect(result.summary.requiredOperationsFound).toBe(6);
    expect(result.summary.breakingChangesCount).toBe(0);
  });

  test('passes validation when candidate adds non-breaking new endpoints and fields', () => {
    const candidateWithAdditions: OpenApiSchema = {
      ...VALID_BASELINE_SPEC,
      paths: {
        ...VALID_BASELINE_SPEC.paths,
        '/api/session/{sessionID}/prompt': {
          post: {
            operationId: 'session.prompt',
            summary: 'Send prompt',
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      text: { type: 'string' },
                      temperature: { type: 'number' }, // new optional property
                    },
                  },
                },
              },
            },
          },
        },
        '/api/experimental/vision': {
          post: {
            operationId: 'experimental.vision',
            summary: 'Brand new endpoint',
          },
        },
      },
    };

    const result = verifyOpenCodeSchema(candidateWithAdditions);
    expect(result.compatible).toBe(true);
    expect(result.breakingChanges).toHaveLength(0);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
  });

  test('fails validation when a required endpoint is removed', () => {
    const brokenCandidate: OpenApiSchema = {
      ...VALID_BASELINE_SPEC,
      paths: {
        ...VALID_BASELINE_SPEC.paths,
      },
    };
    // Delete prompt endpoint
    delete brokenCandidate.paths!['/api/session/{sessionID}/prompt'];

    const result = verifyOpenCodeSchema(brokenCandidate);
    expect(result.compatible).toBe(false);
    expect(result.breakingChanges.some((c: string) => c.includes('prompt'))).toBe(true);
    expect(result.summary.breakingChangesCount).toBeGreaterThan(0);
  });

  test('fails validation when a required HTTP method is removed or altered', () => {
    const brokenCandidate: OpenApiSchema = {
      ...VALID_BASELINE_SPEC,
      paths: {
        ...VALID_BASELINE_SPEC.paths,
        '/api/session/{sessionID}/interrupt': {
          get: { // Changed from POST to GET
            operationId: 'session.interrupt.status',
          },
        },
      },
    };

    const result = verifyOpenCodeSchema(brokenCandidate);
    expect(result.compatible).toBe(false);
    expect(result.breakingChanges.some((c: string) => c.includes('POST') && c.includes('interrupt'))).toBe(true);
  });

  test('formats comprehensive diff report with status and violations', () => {
    const brokenCandidate: OpenApiSchema = {
      ...VALID_BASELINE_SPEC,
      paths: {
        '/api/session': VALID_BASELINE_SPEC.paths!['/api/session']!,
      },
    };

    const result = verifyOpenCodeSchema(brokenCandidate);
    const report = formatDiffReport(result);

    expect(report).toContain('OpenCode Upgrade Gate Report');
    expect(report).toContain('Status: FAILED (Breaking Changes Detected)');
    expect(report).toContain('Breaking Changes:');
  });
});
