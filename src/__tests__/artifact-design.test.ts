import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createDesignTransportMock } from '@zibby/artifact-contracts/mock-transport';
import { threeArtboards, singleBoardUpdate, versionTwo, makeHighEscapeSnapshot } from '@zibby/artifact-contracts/fixtures';
import { MAX_SNAPSHOT_BYTES, PrepareRequestSchema, PublishRequestSchema, RestoreRequestSchema, RevisionReceiptSchema } from '@zibby/artifact-contracts';
import { artifactSkill, ARTIFACT_OWNER_ENV, __resetPublishBudget } from '../artifact.js';
import { handleSharedSkillRequest } from '../sharedMcpServer.js';

const clone = x => JSON.parse(JSON.stringify(x));
const call = async (name, args) => JSON.parse(await artifactSkill.handleToolCall(name, args));
const create = (extra = {}) => call('artifact_publish', { artifactType: 'design', projectId: 'mock-project', title: '三板设计', design: clone(threeArtboards), ...extra });
let records, requests, receipts, mock, fault, indexFailure;

beforeEach(() => {
  vi.stubEnv('PROJECT_API_TOKEN', 'mock-token');
  vi.stubEnv('ZIBBY_ACCOUNT_API_URL', 'https://api.mock.invalid');
  vi.stubEnv('WORKFLOW_TYPE', 'arbitrary-agent');
  vi.stubEnv(ARTIFACT_OWNER_ENV, 'original-owner');
  records = new Map(); requests = []; receipts = []; fault = undefined; indexFailure = undefined;
  __resetPublishBudget();
  mock = createDesignTransportMock({ crypto: webcrypto, now: () => '2026-10-31T04:30:00.000Z',
    validateHtml: html => html.includes('SERVER_REJECT') ? [{ code: 'html-defect', message: 'Server rejected this board', path: ['html'] }] : [],
  });
  vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
    const url = String(input);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const req = { url, method: init.method || 'GET', body, headers: new Headers(init.headers) };
    requests.push(req);
    if (url.endsWith('/credits/review-memory')) {
      if (body.op === indexFailure) return new Response('{}', { status: 503 });
      if (body.op === 'store') { records.set(body.scope, JSON.parse(body.content)); return Response.json({ stored: true }); }
      const record = records.get(body.scope);
      return Response.json(record ? { found: true, memory: { content: JSON.stringify(record) } } : { found: false });
    }
    const response = await mock.fetch(input, init);
    if (url.startsWith('https://api.mock.invalid') && response.status === 201 && !url.endsWith('design-uploads')) receipts.push(await response.clone().json());
    return fault ? await fault(req, response) : response;
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('generic artifact design lifecycle with the 892 transport mock', () => {
  it('creates 3 boards, reads all V1 source, patches one into V2, lists history, reads old source and restores as V3', async () => {
    const v1 = await create();
    expect(v1.committed).toBe(true);
    expect(v1.commit).toEqual({ artifactId: receipts[0].artifactId, currentVersion: 1, revision: receipts[0].revision });
    expect(v1.revision.snapshot).toEqual(threeArtboards);
    const old = await call('artifact_get', { id: v1.id, artifactType: 'design', version: 1 });
    expect(old.revision.snapshot).toEqual(threeArtboards);
    const v2 = await call('artifact_update', { id: v1.id, artifactType: 'design', projectId: 'mock-project', baseVersion: 1, summary: '修改第二板', operations: singleBoardUpdate });
    expect(v2.commit).toEqual({ artifactId: receipts[1].artifactId, currentVersion: 2, revision: receipts[1].revision });
    expect(v2.revision.snapshot).toEqual(versionTwo);
    expect(v2.revision.snapshot.artboards.map(b => b.id)).toEqual(threeArtboards.artboards.map(b => b.id));
    const latest = await call('artifact_get', { id: v1.id });
    expect(latest.revision.snapshot).toEqual(versionTwo);
    const page1 = await call('artifact_versions', { id: v1.id, limit: 1 });
    expect(page1.items.map(r => r.version)).toEqual([2]);
    expect(page1.items[0].summary).toBe('修改第二板');
    const page2 = await call('artifact_versions', { id: v1.id, cursor: page1.nextCursor, limit: 1 });
    expect(page2.items.map(r => r.version)).toEqual([1]);
    expect((await call('artifact_get', { id: v1.id, version: 1 })).revision.snapshot).toEqual(threeArtboards);
    const restored = await call('artifact_restore', { id: v1.id, baseVersion: 2, version: 1, summary: '恢复原稿' });
    expect(restored.commit.revision).toMatchObject({ version: 3, restoredFromVersion: 1 });
    expect(restored.revision.snapshot).toEqual(threeArtboards);
    const index = records.get(`original-owner:artifact:${v1.id}`);
    expect(index).toMatchObject({ artifactType: 'design', ownerNamespace: 'original-owner', currentVersion: 3, revisionId: restored.commit.revision.revisionId, createdAt: v1.artifact.createdAt });
    for (const req of requests) {
      if (req.url.endsWith('/artifacts/design-uploads')) PrepareRequestSchema.parse(req.body);
      if (req.url.endsWith('/credits/artifacts') && req.method === 'POST') PublishRequestSchema.parse(req.body);
      if (req.url.endsWith('/restore')) RestoreRequestSchema.parse(req.body);
      if (req.url.startsWith('https://objects.mock.invalid')) expect(req.headers.has('authorization')).toBe(false);
    }
    for (const receipt of receipts) RevisionReceiptSchema.parse(receipt);
    expect(mock.controls.every(c => c.sizeBytes <= 262144)).toBe(true);
  });

  it('generates only absent initial board IDs, then keeps those IDs on replacement and rejects missing update IDs', async () => {
    const snapshot = clone(threeArtboards);
    delete snapshot.artboards[1].id;
    const v1 = await create({ design: snapshot });
    const ids = v1.revision.snapshot.artboards.map(b => b.id);
    expect(ids[0]).toBe('board-1'); expect(ids[1]).toMatch(/^[a-f0-9-]{36}$/);
    const replacement = clone(v1.revision.snapshot);
    replacement.artboards[1].name = '改名';
    const v2 = await call('artifact_update', { id: v1.id, artifactType: 'design', projectId: 'mock-project', baseVersion: 1, summary: '改名', design: replacement });
    expect(v2.revision.snapshot.artboards.map(b => b.id)).toEqual(ids);
    delete replacement.artboards[1].id;
    const bad = await call('artifact_update', { id: v1.id, artifactType: 'design', projectId: 'mock-project', baseVersion: 2, design: replacement });
    expect(bad.code).toBe('INVALID_STRUCTURE');
    expect(receipts).toHaveLength(2);
  });

  it('preserves existing ownership, createdAt and unrelated index metadata through updates and restores', async () => {
    const v1 = await create();
    const key = `original-owner:artifact:${v1.id}`;
    records.set(key, { ...records.get(key), createdAt: '2025-01-01T00:00:00.000Z', url: 'https://viewer.invalid/existing', custom: 'keep' });
    await call('artifact_update', { id: v1.id, artifactType: 'design', projectId: 'mock-project', baseVersion: 1, operations: singleBoardUpdate });
    await call('artifact_restore', { id: v1.id, baseVersion: 2, version: 1 });
    expect(records.get(key)).toMatchObject({ ownerNamespace: 'original-owner', createdAt: '2025-01-01T00:00:00.000Z', custom: 'keep', url: 'https://viewer.invalid/existing', currentVersion: 3 });
    expect([...records.keys()]).toEqual([key]);
  });

  it('forwards bound ownership and backend session through the generic resolved skill', async () => {
    const resolved = await artifactSkill.resolve();
    expect(resolved.env).toMatchObject({ [ARTIFACT_OWNER_ENV]: 'original-owner', PROJECT_API_TOKEN: 'mock-token', ZIBBY_ACCOUNT_API_URL: 'https://api.mock.invalid', WORKFLOW_TYPE: 'arbitrary-agent' });
  });
});

describe('design errors and confirmed commit recovery', () => {
  it.each(['html', 'markdown', 'text', 'data', 'share', 'contentType', 'uploadId'])('rejects mixed legacy %s without making requests', async field => {
    const out = await create({ [field]: field === 'data' ? {} : field === 'share' ? true : 'mixed' });
    expect(out).toMatchObject({ status: 400, code: 'INVALID_STRUCTURE' });
    expect(requests).toHaveLength(0);
  });
  it('rejects full snapshot plus operations and missing discriminator, baseVersion or projectId', async () => {
    expect((await create({ operations: singleBoardUpdate })).status).toBe(400);
    expect((await create({ artifactType: undefined })).status).toBe(400);
    expect((await create({ projectId: undefined })).status).toBe(400);
    expect((await call('artifact_restore', { id: 'id', baseVersion: 1, version: 1, design: threeArtboards })).status).toBe(400);
    expect((await call('artifact_update', { id: 'id', artifactType: 'design', projectId: 'mock-project', operations: singleBoardUpdate })).status).toBe(400);
    expect(requests).toHaveLength(0);
  });
  it('returns server defects per board without applying document preflight or consuming the legacy retry budget', async () => {
    const snapshot = clone(threeArtboards); snapshot.artboards[1].html = 'SERVER_REJECT';
    for (let i = 0; i < 3; i++) {
      const out = await create({ design: snapshot });
      expect(out).toMatchObject({ status: 422, code: 'INVALID_CONTENT', defects: [{ artboardId: 'board-2', code: 'html-defect', path: ['html'] }] });
    }
    expect((await create()).committed).toBe(true);
    expect(requests.filter(r => r.url.endsWith('/credits/artifacts'))).toHaveLength(4);
  });
  it('returns stale base/current version conflict and does not replay or overwrite the index', async () => {
    const v1 = await create();
    await call('artifact_update', { id: v1.id, artifactType: 'design', projectId: 'mock-project', baseVersion: 1, operations: singleBoardUpdate });
    const count = receipts.length;
    const conflict = await call('artifact_update', { id: v1.id, artifactType: 'design', projectId: 'mock-project', baseVersion: 1, operations: singleBoardUpdate });
    expect(conflict).toMatchObject({ status: 409, code: 'VERSION_CONFLICT', baseVersion: 1, currentVersion: 2 });
    expect(conflict.instruction).toContain('Read the current'); expect(receipts).toHaveLength(count);
    expect(records.get(`original-owner:artifact:${v1.id}`).currentVersion).toBe(2);
  });
  it('uses raw transfers for a near-5MiB escaped snapshot and returns total-byte limit facts for overflow', async () => {
    const v1 = await create({ design: makeHighEscapeSnapshot(MAX_SNAPSHOT_BYTES) });
    expect(v1.committed).toBe(true);
    expect(mock.transfers.find(x => x.direction === 'upload').sizeBytes).toBe(MAX_SNAPSHOT_BYTES);
    const bad = await create({ design: makeHighEscapeSnapshot(MAX_SNAPSHOT_BYTES + 1) });
    expect(bad).toMatchObject({ status: 413, code: 'CONTENT_TOO_LARGE', maxSnapshotBytes: MAX_SNAPSHOT_BYTES });
    expect(receipts).toHaveLength(1);
  });

  it.each(['create', 'replace', 'patch', 'restore'].flatMap(action => [1, 2].map(download => ({ action, download }))))('$action retains receipt/index when download $download fails; fixed GET recovers without replay', async ({ action, download }) => {
    const initial = action === 'create' ? undefined : await create();
    let n = 0;
    fault = (req, res) => req.url.startsWith('https://objects.mock.invalid/download/') && ++n === download ? new Response('', { status: 503 }) : res;
    const out = action === 'create' ? await create()
      : action === 'restore' ? await call('artifact_restore', { id: initial.id, baseVersion: 1, version: 1 })
      : await call('artifact_update', { id: initial.id, artifactType: 'design', projectId: 'mock-project', baseVersion: 1, summary: '修改', ...(action === 'patch' ? { operations: singleBoardUpdate } : { design: clone(versionTwo) }) });
    expect(out).toMatchObject({ committed: true, readBack: { status: 'unverified' } });
    expect(out.revision).toBeUndefined(); expect(out.instruction).toContain('Do not repeat');
    const receipt = receipts.at(-1);
    expect(out.commit).toEqual({ artifactId: receipt.artifactId, currentVersion: receipt.currentVersion, revision: receipt.revision });
    expect(records.get(`original-owner:artifact:${out.id}`)).toMatchObject({ artifactType: 'design', currentVersion: out.commit.currentVersion, revisionId: out.commit.revision.revisionId, createdAt: initial?.artifact.createdAt || out.commit.revision.createdAt });
    expect(JSON.stringify(out)).not.toContain('objects.mock.invalid');
    const writes = receipts.length;
    fault = undefined;
    // Head moves forward; recovery must still address the original immutable version.
    await call('artifact_update', { id: out.id, artifactType: 'design', projectId: 'mock-project', baseVersion: out.commit.currentVersion, operations: [{ op: 'move', artboardId: 'board-1', x: 123, y: 456 }] });
    const recovered = await call('artifact_get', { id: out.id, artifactType: 'design', version: out.commit.revision.version });
    expect(recovered.revision.metadata.revisionId).toBe(out.commit.revision.revisionId);
    expect(recovered.revision.snapshot.artboards[0].x).toBe(threeArtboards.artboards[0].x);
    expect(receipts).toHaveLength(writes + 1);
  });

  it('does not claim a commit or update the index when the publish receipt is malformed', async () => {
    fault = (req, res) => req.url.endsWith('/credits/artifacts') && req.method === 'POST' ? Response.json({ artifactId: 'untrusted' }, { status: 201 }) : res;
    const out = await create();
    expect(out.committed).toBeUndefined(); expect(out.error).toBeTruthy(); expect(records.size).toBe(0);
    expect(receipts).toHaveLength(1);
  });
  it('hydrates generic GET through the shared parser even for an incomplete design receipt', async () => {
    const v1 = await create();
    fault = (req, res) => req.url.includes(`/artifacts/${v1.id}`) && req.method === 'GET'
      ? Response.json({ details: { url: 'https://objects.mock.invalid/private-capability' } }) : res;
    const out = await call('artifact_get', { id: v1.id });
    expect(out.error).toBeTruthy();
    expect(JSON.stringify(out)).not.toContain('private-capability');
  });
  it.each(['recall', 'store'])('keeps confirmed commit during index %s outage and preserves the old record', async op => {
    const v1 = await create(); const key = `original-owner:artifact:${v1.id}`; const old = clone(records.get(key));
    indexFailure = op;
    const out = await call('artifact_update', { id: v1.id, artifactType: 'design', projectId: 'mock-project', baseVersion: 1, operations: singleBoardUpdate });
    expect(out).toMatchObject({ committed: true, commit: { currentVersion: 2 } });
    expect(out.indexWarning).toBeTruthy(); expect(records.get(key)).toEqual(old); expect(receipts).toHaveLength(2);
  });
});

it('keeps explicitly published JSON text on the existing file transport, even when its contents describe a design', async () => {
  const source = JSON.stringify(threeArtboards);
  const legacy = vi.fn(async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith('/credits/review-memory')) return Response.json({ stored: true });
    if (init.method === 'POST') {
      expect(JSON.parse(init.body)).toMatchObject({ text: source, contentType: 'application/json' });
      return Response.json({ id: 'legacy-file', url: 'https://viewer.invalid/legacy-file' });
    }
    return Response.json({ metadata: { id: 'legacy-file', contentType: 'application/json' }, content: source, format: 'text' });
  });
  vi.stubGlobal('fetch', legacy);
  expect(await call('artifact_publish', { title: 'design.json', text: source, contentType: 'application/json' })).toEqual({ id: 'legacy-file', url: 'https://viewer.invalid/legacy-file' });
  expect(legacy.mock.calls.some(([url]) => String(url).includes('design-uploads'))).toBe(false);
});

it('an unrelated agent declaring artifact discovers and calls the same design tools through generic MCP', async () => {
  const serve = async (method, params = undefined) => {
    const response = await handleSharedSkillRequest({ serverName: artifactSkill.serverName, skill: artifactSkill,
      allowedTools: artifactSkill.tools.map(t => t.name), context: { executionId: 'unrelated-run', projectId: 'mock-project', workflowType: 'third-party-agent' },
      request: new Request('http://localhost/mcp/skills/artifact', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }),
    });
    expect(response.status).toBe(200);
    const body = await response.text();
    return JSON.parse(response.headers.get('content-type')?.includes('text/event-stream') ? body.split('\n').find(line => line.startsWith('data: ')).slice(6) : body);
  };
  const listed = (await serve('tools/list')).result.tools;
  expect(listed.map(t => t.name)).toEqual(expect.arrayContaining(['artifact_publish', 'artifact_get', 'artifact_update', 'artifact_versions', 'artifact_restore']));
  expect(listed.find(t => t.name === 'artifact_update').inputSchema.properties).toHaveProperty('operations');
  const invoked = await serve('tools/call', { name: 'artifact_publish', arguments: { title: '通用能力', artifactType: 'design', projectId: 'mock-project', design: clone(threeArtboards) } });
  expect(JSON.parse(invoked.result.content[0].text)).toMatchObject({ committed: true, readBack: { status: 'verified' } });
});
