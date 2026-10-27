import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { capabilitiesReport } from '../../src/mcp/tools/pipeline.js';
import { testCtx } from '../helpers/ctx.js';

describe('pipeline_capabilities', () => {
  it('reports each mode with the reason it is unavailable, never a substitute', () => {
    const r = capabilitiesReport(testCtx()) as any;
    expect(r.command).toBe('/remote-browser-accounts:pipeline');
    expect(r.executionModes.local.available).toBe(true);
    expect(r.executionModes.remote_direct).toMatchObject({ available: false });
    expect(r.executionModes.remote_direct.reason).toContain('APIFY_TOKEN');
    expect(r.executionModes.remote_proxy.available).toBe(false);
    expect(r.defaultMode).toBe('remote_direct');
    expect(JSON.stringify(r)).toContain("No mode is anonymous");
    expect(JSON.stringify(r)).not.toMatch(/fully anonymous/i);
    const files = r.stages.find((s: any) => s.stage === 'files');
    expect(files.tools).toContain('media_sanitize');
  });

  it('local mode is reported unavailable when the provider is absent', () => {
    const r = capabilitiesReport(testCtx({}, { localProvider: null })) as any;
    expect(r.executionModes.local).toMatchObject({ available: false, reason: 'disabled in this installation' });
  });

  it('pipeline skill triggers on web tasks and excludes CI/data pipelines', () => {
    const skill = readFileSync(new URL('../../skills/pipeline/SKILL.md', import.meta.url), 'utf8');
    const desc = /description: (.*)/.exec(skill)![1]!;
    expect(desc).toMatch(/use the pipeline to/i);
    expect(desc).toMatch(/Do NOT use for CI\/CD pipelines/);
    expect(skill).not.toMatch(/production ready|works on any website|10\/10/i);
  });
});
