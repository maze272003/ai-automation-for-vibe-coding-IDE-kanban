// apps/skill-vault/src/github.ts — GitHub source resolution and tarball download.
//
// Quota strategy (all official interfaces):
//   * `git ls-remote --symref` (smart HTTP) resolves default branch + HEAD commit WITHOUT
//     consuming the 60/h anonymous REST API quota — used for commit pinning.
//   * codeload.github.com tarballs are not API calls and carry no such quota.
//   * api.github.com is used opportunistically under a strict per-run budget for
//     license/metadata enrichment, and is always optional.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PoliteHttpClient } from './http.ts';
import type { Logger } from './log.ts';

const execFileAsync = promisify(execFile);

export type RepoHead = { owner: string; repo: string; branch: string; commit: string; via: 'ls-remote' | 'api' };

export class GithubResolver {
  private apiCalls = 0;
  private readonly http: PoliteHttpClient;
  private readonly logger: Logger;
  private readonly apiBudget: number;

  constructor(http: PoliteHttpClient, logger: Logger, apiBudget: number) {
    this.http = http;
    this.logger = logger;
    this.apiBudget = apiBudget;
  }

  get apiCallsUsed(): number {
    return this.apiCalls;
  }

  /** Resolve the default branch and its head commit without REST API quota. */
  async resolveHead(owner: string, repo: string): Promise<RepoHead> {
    const url = `https://github.com/${owner}/${repo}.git`;
    const { stdout } = await execFileAsync('git', ['ls-remote', '--symref', url, 'HEAD'], {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    let branch = '';
    let commit = '';
    for (const line of stdout.split('\n')) {
      const symref = /^ref:\s+refs\/heads\/(\S+)\s+HEAD/.exec(line.trim());
      if (symref) branch = symref[1]!;
      const head = /^([0-9a-f]{40})\s+HEAD$/.exec(line.trim());
      if (head) commit = head[1]!;
    }
    if (branch.length === 0 || commit.length === 0) {
      throw new Error(`Could not resolve HEAD for ${owner}/${repo}`);
    }
    return { owner, repo, branch, commit, via: 'ls-remote' };
  }

  /** Optional metadata enrichment via the REST API, strictly budgeted. Returns undefined when out of budget. */
  async repoMetadata(owner: string, repo: string): Promise<
    | {
        defaultBranch: string;
        license: string | null;
        pushedAt: string | null;
        stars: number | null;
        archived: boolean;
      }
    | undefined
  > {
    if (this.apiCalls >= this.apiBudget) return undefined;
    this.apiCalls += 1;
    try {
      const body = await this.http.getJson<{
        default_branch?: string;
        license?: { spdx_id?: string | null } | null;
        pushed_at?: string | null;
        stargazers_count?: number;
        archived?: boolean;
      }>(`https://api.github.com/repos/${owner}/${repo}`, 512 * 1024);
      return {
        defaultBranch: body.default_branch ?? '',
        license: body.license?.spdx_id && body.license.spdx_id !== 'NOASSERTION' ? body.license.spdx_id : null,
        pushedAt: body.pushed_at ?? null,
        stars: body.stargazers_count ?? null,
        archived: body.archived === true,
      };
    } catch (error) {
      this.logger.debug('github api metadata failed', { owner, repo, error: (error as Error).message });
      return undefined;
    }
  }
}

export const codeloadTarballUrl = (owner: string, repo: string, commitOrBranch: string): string =>
  `https://codeload.github.com/${owner}/${repo}/tar.gz/${commitOrBranch}`;

/** Best-effort SPDX detection from a LICENSE file's text. */
export function detectLicense(text: string): string | null {
  const head = text.slice(0, 4096);
  const rules: Array<[RegExp, string]> = [
    [/MIT License|Permission is hereby granted, free of charge/i, 'MIT'],
    [/Apache License\s*(?:Version\s*)?2/i, 'Apache-2.0'],
    [/GNU GENERAL PUBLIC LICENSE\s*.{0,40}Version 3/i, 'GPL-3.0'],
    [/GNU GENERAL PUBLIC LICENSE\s*.{0,40}Version 2/i, 'GPL-2.0'],
    [/GNU AFFERO GENERAL PUBLIC LICENSE/i, 'AGPL-3.0'],
    [/GNU LESSER GENERAL PUBLIC LICENSE/i, 'LGPL-3.0'],
    [/BSD 3-Clause License|Redistribution and use in source and binary forms.{0,200}neither the name/i, 'BSD-3-Clause'],
    [/BSD 2-Clause License|Redistribution and use in source and binary forms/i, 'BSD-2-Clause'],
    [/ISC License|THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES/i, 'ISC'],
    [/Mozilla Public License\s*(?:Version\s*)?2/i, 'MPL-2.0'],
    [/The Unlicense|this is free and unencumbered software released into the public domain/i, 'Unlicense'],
    [/Creative Commons Zero|CC0 1\.0 Universal/i, 'CC0-1.0'],
    [/Eclipse Public License/i, 'EPL-1.0'],
  ];
  for (const [pattern, spdx] of rules) {
    if (pattern.test(head)) return spdx;
  }
  return null;
}
