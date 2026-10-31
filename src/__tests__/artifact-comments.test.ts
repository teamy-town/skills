import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { createDesignTransportMock } from '@zibby/artifact-contracts/mock-transport';
import { threeArtboards, singleBoardUpdate, versionTwo } from '@zibby/artifact-contracts/fixtures';
import { createCommentMock, commentAnchorFixtures, commentRequestFixtures, commentRoutes, COMMENT_HTTP_OPERATIONS, CommentListQuerySchema, createCommentInboxReplyTo, createCommentReplyTo } from '@zibby/artifact-contracts/comment';
import { artifactSkill, __resetPublishBudget } from '../artifact.js';
import { handleSharedSkillRequest } from '../sharedMcpServer.js';

// Tests never inspect a developer's real CLI session when testing missing auth.
vi.mock('node:os', async importOriginal => ({ ...await importOriginal(), homedir: () => '/nonexistent/artifact-comment-tests' }));

const clone = x => JSON.parse(JSON.stringify(x));
const call = async (name, args) => JSON.parse(await artifactSkill.handleToolCall(name, args));
const accountId = 'mock-account', projectId = 'mock-project';
const actor = (id, kind = 'person') => ({ accountId, projectId, author: { kind, id, name: '同名成员' } });
const member = actor('member-1'), otherMember = actor('member-2'), agent = actor('mock-agent', 'agent');
const contexts = new Map([['mock-token', agent], ['member-session', member], ['other-member-session', otherMember], ['outsider-session', actor('outsider')], ['external-password', actor('password-reader')]]);
const routes = commentRoutes({ mount: '/credits' });
let comments, design, revisions, requests, sent, fault;
const scope = id => ({ accountId, projectId, artifactId: id });
const remember = out => { if (out.revision) revisions.set(`${out.id}:${out.revision.metadata.version}`, clone(out.revision)); return out; };
const create = async () => remember(await call('artifact_publish', { title: '原始三板', artifactType: 'design', projectId, design: clone(threeArtboards) }));
const seed = (id, key = 'root', anchor = commentAnchorFixtures.artboard, text = commentRequestFixtures.root.text) => comments.create(scope(id), { ...clone(commentRequestFixtures.root), idempotencyKey: key, anchor: clone(anchor), text }, member).comment;
const reference = out => { const { artifactId, revisionId, version } = out.commit.revision; return { artifactId, revisionId, version }; };
const all = async (name, args) => {
  const items = []; let cursor;
  do {
    const page = await call(name, { ...args, limit: 1, ...(cursor ? { cursor } : {}) });
    expect(page.error).toBeUndefined(); items.push(...page.items); cursor = page.nextCursor;
  } while (cursor !== null);
  return items;
};

beforeEach(() => {
  vi.stubEnv('PROJECT_API_TOKEN', 'mock-token');
  vi.stubEnv('ZIBBY_USER_TOKEN', '');
  vi.stubEnv('ZIBBY_ACCOUNT_API_URL', 'https://api.mock.invalid');
  vi.stubEnv('WORKFLOW_TYPE', 'third-party-agent');
  __resetPublishBudget(); revisions = new Map(); requests = []; sent = []; fault = undefined;
  design = createDesignTransportMock({ crypto: webcrypto, now: () => '2026-10-31T08:00:00.000Z' });
  comments = createCommentMock({
    readVersion: (s, version) => s.accountId === accountId && s.projectId === projectId ? clone(revisions.get(`${s.artifactId}:${version}`) || null) : null,
    authorize: ({ context }) => ['member-1', 'member-2', 'mock-agent'].includes(context.author.id),
    resolveTarget: ({ target }) => target.workflowUuid === 'unavailable'
      ? { available: false, failure: { code: 'TARGET_UNAVAILABLE', message: '所选 agent 已删除，无法投递' } } : { available: true, target },
    deliver: input => { sent.push(input); return { accepted: input.target.workflowUuid !== 'rejected', messageId: `inbox-${input.commentReplyTo.deliveryId}`, reason: 'already-awake' }; },
    now: () => '2026-10-31T08:01:00.000Z',
  });
  vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
    const url = new URL(String(input));
    const req = { url: String(input), method: init.method || 'GET', headers: new Headers(init.headers), body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined };
    requests.push(req);
    const failure = fault && await fault(req); if (failure) return failure;
    if (url.pathname === '/credits/review-memory') return Response.json(req.body.op === 'recall' ? { found: false } : { stored: true });
    const parts = url.pathname.split('/').map(decodeURIComponent);
    if (url.origin === 'https://api.mock.invalid' && parts[4] === 'comments') {
      const id = parts[3], commentId = parts[5];
      const operation = !commentId ? 'list' : parts[6] === 'resolve' ? 'resolve' : req.method === 'GET' ? 'replies' : 'reply';
      const spec = COMMENT_HTTP_OPERATIONS[operation];
      expect(req.method).toBe(spec.method);
      const query = Object.fromEntries([...url.searchParams].map(([k, v]) => [k, k === 'limit' ? Number(v) : v]));
      const data = (spec.request || CommentListQuerySchema).parse(spec.request ? req.body : query);
      expect(url.pathname + url.search).toBe(operation === 'list' ? routes.list(id, query) : operation === 'replies' ? routes.replies(id, commentId, query) : routes[operation](id, commentId));
      const context = contexts.get(req.headers.get('authorization')?.replace('Bearer ', ''));
      try {
        const out = operation === 'list' ? comments.list(scope(id), data, context) : comments[operation](scope(id), commentId, data, context);
        spec.response.parse(out);
        return Response.json(out, { status: out.duplicate ? spec.duplicateStatus : spec.successStatus });
      } catch (error) { return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status || 500 }); }
    }
    return design.fetch(input, init);
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('shared comment contract through the generic artifact capability', () => {
  it('returns one honest page, then cursor consumers read full roots/replies, original versions and all anchor kinds', async () => {
    const v1 = await create(); const long = '完整正文 @同名成员\n'.repeat(2000);
    const roots = Object.values(commentAnchorFixtures).map((anchor, i) => seed(v1.id, `root-${i}`, anchor, `${i}:${long}`));
    for (let i = 0; i < 3; i++) comments.reply(scope(v1.id), roots[0].id, { idempotencyKey: `reply-${i}`, text: `${i}:${long}`, designVersion: reference(v1) }, member);
    requests = [];
    const page = await call('artifact_comments', { id: v1.id, limit: 1 });
    expect(page.items).toHaveLength(1); expect(page.nextCursor).toBeTypeOf('string'); expect(requests).toHaveLength(1);
    expect(requests[0].headers.get('authorization')).toBe('Bearer mock-token'); expect(requests[0].body).toBeUndefined();
    const loaded = await all('artifact_comments', { id: v1.id });
    expect(loaded.map(c => c.id)).toEqual(roots.map(c => c.id));
    loaded.forEach((c, i) => expect(c).toMatchObject({ anchor: roots[i].anchor, text: `${i}:${long}`, sourceVersion: 1, sourceRevisionId: v1.commit.revision.revisionId }));
    expect(await all('artifact_comment_replies', { id: v1.id, commentId: roots[0].id })).toEqual(comments.replies(scope(v1.id), roots[0].id, {}, member).items);
    expect(sent).toHaveLength(0);
  });

  it('reads original discussion/design, changes only the requested board, replies with the confirmed V2 receipt to that thread, never resolves', async () => {
    const v1 = await create(); const root = seed(v1.id, 'requested', { ...commentAnchorFixtures.artboard, artboardId: 'board-2' });
    const unrelated = seed(v1.id, 'unrelated');
    const page = await call('artifact_comments', { id: v1.id });
    const original = await call('artifact_get', { id: v1.id, version: page.items[0].sourceVersion });
    expect(original.revision.snapshot).toEqual(threeArtboards);
    const v2 = remember(await call('artifact_update', { id: v1.id, artifactType: 'design', projectId, baseVersion: 1, operations: clone(singleBoardUpdate), summary: '按指定评论修改第二板' }));
    expect(v2.revision.snapshot).toEqual(versionTwo);
    for (const i of [0, 2]) expect(v2.revision.snapshot.artboards[i]).toEqual(original.revision.snapshot.artboards[i]);
    expect(v2.revision.snapshot.artboards[1]).not.toEqual(original.revision.snapshot.artboards[1]);
    const reply = await call('artifact_comment_reply', { id: v1.id, commentId: root.id, idempotencyKey: 'result-v2', text: '第二板已更新，见新版本。@同名成员', designVersion: reference(v2) });
    expect(reply).toMatchObject({ duplicate: false, reply: { artifactId: v1.id, commentId: root.id, designVersion: reference(v2), author: agent.author } });
    expect((await call('artifact_comment_replies', { id: v1.id, commentId: root.id })).items).toEqual([reply.reply]);
    expect((await call('artifact_comment_replies', { id: v1.id, commentId: unrelated.id })).items).toEqual([]);
    const after = (await call('artifact_comments', { id: v1.id })).items[0];
    expect(after).toEqual({ ...root, replyCount: 1 });
    expect((await call('artifact_get', { id: v1.id, version: 1 })).revision.snapshot).toEqual(threeArtboards);
    expect(requests.some(r => r.url.endsWith('/resolve'))).toBe(false); expect(sent).toHaveLength(0);
  });

  it('retains a deleted board pin on V1 and can reply after V2 removes the board', async () => {
    const v1 = await create(); const root = seed(v1.id);
    remember(await call('artifact_update', { id: v1.id, artifactType: 'design', projectId, baseVersion: 1, design: { ...clone(threeArtboards), artboards: clone(threeArtboards.artboards.slice(0, 2)) } }));
    expect((await call('artifact_comments', { id: v1.id })).items).toEqual([root]);
    const old = await call('artifact_get', { id: v1.id, version: root.sourceVersion });
    expect(old.revision.snapshot.artboards.find(b => b.id === root.anchor.artboardId)).toBeTruthy();
    expect(await call('artifact_comment_reply', { id: v1.id, commentId: root.id, idempotencyKey: 'old-pin', text: '讨论仍在原版' })).toMatchObject({ duplicate: false, reply: { commentId: root.id } });
  });

  it('lets a different authorized comment member explicitly resolve/reopen; replies preserve either state and all contents', async () => {
    const v1 = await create(); const root = seed(v1.id);
    vi.stubEnv('PROJECT_API_TOKEN', 'other-member-session');
    const resolved = await call('artifact_comment_resolve', { id: v1.id, commentId: root.id, resolved: true });
    expect(resolved.comment.resolution).toMatchObject({ resolved: true, changedBy: otherMember.author });
    await call('artifact_comment_reply', { id: v1.id, commentId: root.id, idempotencyKey: 'followup', text: '补充意见不重开' });
    expect((await call('artifact_comments', { id: v1.id })).items[0].resolution).toEqual(resolved.comment.resolution);
    const reopened = await call('artifact_comment_resolve', { id: v1.id, commentId: root.id, resolved: false });
    expect(reopened.comment).toMatchObject({ text: root.text, anchor: root.anchor, replyCount: 1, resolution: { resolved: false, changedBy: otherMember.author } });
    expect((await call('artifact_comment_replies', { id: v1.id, commentId: root.id })).items[0].text).toBe('补充意见不重开');
  });

  it('preserves actual pending/failed/answered delivery facts and service-generated final reply receipts', async () => {
    const v1 = await create();
    const seeded = ['selected', 'unavailable', 'rejected'].map((workflowUuid, i) => comments.create(scope(v1.id), { ...clone(commentRequestFixtures.mention), idempotencyKey: `mention-${i}`, mentionTarget: { accountId, projectId, workflowUuid } }, member).comment);
    expect((await call('artifact_comments', { id: v1.id })).items).toEqual(seeded);
    expect(seeded[0].delivery).toMatchObject({ status: 'pending', queueReason: 'already-awake' }); expect(seeded[0].delivery.executionId).toBeUndefined();
    expect(seeded[1].delivery.failure).toEqual({ code: 'TARGET_UNAVAILABLE', message: '所选 agent 已删除，无法投递' });
    expect(seeded[2].delivery.failure.code).toBe('DELIVERY_REJECTED');
    const delivery = comments.bindExecution(createCommentInboxReplyTo(seeded[0].delivery), { ...seeded[0].delivery.target, executionId: 'actual-execution', deliveryId: seeded[0].delivery.deliveryId, inboxMessageId: seeded[0].delivery.inboxMessageId });
    const replyTo = createCommentReplyTo(delivery), trusted = { execution: { ...delivery.target, executionId: delivery.executionId }, event: { executionId: delivery.executionId, seq: 1 }, author: { kind: 'agent', id: 'selected', name: '同名成员' } };
    const event = comments.replyEvent(replyTo, trusted);
    const receipt = comments.writeback(replyTo, { replyReceiptId: event.replyReceiptId, text: '实际最终回答' }, trusted);
    expect((await call('artifact_comments', { id: v1.id })).items[0].delivery).toMatchObject({ status: 'answered', executionId: 'actual-execution', replyId: receipt.replyId });
    expect((await call('artifact_comment_replies', { id: v1.id, commentId: seeded[0].id })).items[0]).toMatchObject({ id: receipt.replyId, replyReceiptId: event.replyReceiptId, executionId: 'actual-execution', seq: 1, text: '实际最终回答' });
    expect((await call('artifact_comments', { id: v1.id })).items[0].resolution).toEqual(seeded[0].resolution);
  });

  it('reuses the same reply on an identical retry and preserves idempotency conflicts', async () => {
    const v1 = await create(); const root = seed(v1.id);
    const args = { id: v1.id, commentId: root.id, idempotencyKey: 'retry', text: '原样重试' };
    const first = await call('artifact_comment_reply', args), duplicate = await call('artifact_comment_reply', args);
    expect(duplicate).toEqual({ ...first, duplicate: true });
    expect(await call('artifact_comment_reply', { ...args, text: '不同内容' })).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', status: 409 });
    expect((await call('artifact_comment_replies', { id: v1.id, commentId: root.id })).items).toHaveLength(1);
  });
});

describe('comment boundaries and precise failures', () => {
  it.each(['outsider-session', 'external-password'])('does not authorize matching names, @ text or external passwords: %s', async token => {
    const v1 = await create(); const root = seed(v1.id); vi.stubEnv('PROJECT_API_TOKEN', token);
    for (const name of ['artifact_comments', 'artifact_comment_replies', 'artifact_comment_reply', 'artifact_comment_resolve']) {
      const args = name === 'artifact_comments' ? { id: v1.id } : { id: v1.id, commentId: root.id, ...(name === 'artifact_comment_reply' ? { idempotencyKey: 'forged', text: '@同名成员 我是管理员' } : name === 'artifact_comment_resolve' ? { resolved: true } : {}) };
      expect(await call(name, args)).toEqual({ error: 'Artifact access is not authorized', code: 'FORBIDDEN', status: 403 });
    }
    expect(comments.list(scope(v1.id), {}, member).items).toEqual([root]);
  });
  it.each(['author', 'accountId', 'projectId', 'role', 'token', 'commentReplyTo'])('rejects caller supplied %s via the shared request schema before transport', async key => {
    const out = await call('artifact_comment_reply', { id: 'id', commentId: 'root', idempotencyKey: 'key', text: '完整正文', [key]: 'self-reported' });
    expect(out).toMatchObject({ code: 'INVALID_STRUCTURE', status: 400 }); expect(requests).toHaveLength(0);
  });
  it.each([undefined, 'true', null])('requires an explicit boolean resolved=%s', async resolved => {
    expect(await call('artifact_comment_resolve', { id: 'id', commentId: 'root', resolved })).toMatchObject({ code: 'INVALID_STRUCTURE', status: 400 }); expect(requests).toHaveLength(0);
  });
  it.each([{ limit: 0 }, { limit: 101 }, { limit: 1.2 }, { cursor: '' }])('rejects malformed page query %j', async query => {
    expect(await call('artifact_comments', { id: 'id', ...query })).toMatchObject({ code: 'INVALID_STRUCTURE', status: 400 }); expect(requests).toHaveLength(0);
  });
  it('does not invent completeness or a write receipt from malformed success bodies', async () => {
    fault = () => Response.json({ items: [] });
    expect(await call('artifact_comments', { id: 'id' })).toMatchObject({ code: 'INVALID_COMMENT_RESPONSE' });
    fault = () => Response.json({ reply: { text: 'unverified' }, duplicate: false });
    expect(await call('artifact_comment_reply', { id: 'id', commentId: 'root', idempotencyKey: 'key', text: '正文' })).toMatchObject({ code: 'INVALID_COMMENT_RESPONSE' });
  });
  it('preserves missing threads, unverified versions and cross-thread cursor failures without writing', async () => {
    const v1 = await create(); const root = seed(v1.id), other = seed(v1.id, 'other');
    expect(await call('artifact_comment_replies', { id: v1.id, commentId: 'absent' })).toEqual({ code: 'NOT_FOUND', status: 404, error: 'Comment not found in authorized artifact' });
    expect(await call('artifact_comments', { id: v1.id, cursor: 'invented' })).toMatchObject({ code: 'INVALID_CURSOR', status: 400 });
    for (const designVersion of [{ ...reference(v1), version: 999 }, { ...reference(v1), revisionId: 'forged' }, { ...reference(v1), artifactId: 'another' }]) {
      expect(await call('artifact_comment_reply', { id: v1.id, commentId: root.id, idempotencyKey: 'bad-version', text: '改稿完成', designVersion })).toMatchObject({ code: 'UNVERIFIED_DESIGN_VERSION', status: 422 });
    }
    expect(comments.replies(scope(v1.id), root.id, {}, member).items).toEqual([]);
    for (let i = 0; i < 2; i++) comments.reply(scope(v1.id), root.id, { idempotencyKey: `r-${i}`, text: '完整回复' }, member);
    const page = await call('artifact_comment_replies', { id: v1.id, commentId: root.id, limit: 1 });
    expect(await call('artifact_comment_replies', { id: v1.id, commentId: other.id, cursor: page.nextCursor })).toMatchObject({ code: 'INVALID_CURSOR', status: 400 });
  });
  it.each([['FORBIDDEN', 403], ['VERSION_NOT_FOUND', 404], ['ARTBOARD_NOT_FOUND', 404], ['TARGET_UNAVAILABLE', 422], ['COMMENTS_NOT_STARTED', 503]])('keeps backend %s and its specific reason', async (code, status) => {
    fault = () => Response.json({ error: { code, message: `具体原因：${code}` } }, { status });
    expect(await call('artifact_comments', { id: 'id' })).toEqual({ error: `具体原因：${code}`, code, status });
  });
  it('handles legacy/non-JSON errors and transport failure without exposing capabilities', async () => {
    fault = () => Response.json({ error: '服务尚未启动', code: 'COMMENTS_NOT_STARTED' }, { status: 503 });
    expect(await call('artifact_comments', { id: 'id' })).toEqual({ error: '服务尚未启动', code: 'COMMENTS_NOT_STARTED', status: 503 });
    fault = () => new Response('unavailable', { status: 503 });
    expect(await call('artifact_comments', { id: 'id' })).toMatchObject({ code: 'COMMENT_REQUEST_FAILED', status: 503, error: expect.stringContaining('503') });
    fault = () => { throw new Error('https://capability.invalid/private?secret=do-not-echo'); };
    const failed = await call('artifact_comment_reply', { id: 'id', commentId: 'root', idempotencyKey: 'retry', text: '正文' });
    expect(failed).toMatchObject({ code: 'COMMENT_TRANSPORT_FAILED', error: expect.stringContaining('same idempotencyKey') });
    expect(JSON.stringify(failed)).not.toContain('do-not-echo');
  });
  it('uses shared route encoding and the existing session, without putting identity in command JSON', async () => {
    fault = () => Response.json({ items: [], nextCursor: null });
    const args = { id: 'a/b?#中', commentId: 'c/d?#文', cursor: 'opaque+/=?&', limit: 3 };
    expect(await call('artifact_comment_replies', args)).toEqual({ items: [], nextCursor: null });
    expect(requests[0].url).toBe(`https://api.mock.invalid${routes.replies(args.id, args.commentId, { cursor: args.cursor, limit: 3 })}`);
    expect(requests[0].headers.get('authorization')).toBe('Bearer mock-token'); expect(requests[0].body).toBeUndefined();
  });
  it('requires an existing backend session', async () => {
    vi.stubEnv('PROJECT_API_TOKEN', '');
    expect(await call('artifact_comments', { id: 'id' })).toMatchObject({ code: 'UNAUTHENTICATED', status: 401 }); expect(requests).toHaveLength(0);
  });
});

it('exposes the four comment tools to any agent through existing artifact MCP, with explicit-only state semantics', async () => {
  const serve = async (method, params = undefined) => {
    const response = await handleSharedSkillRequest({ serverName: artifactSkill.serverName, skill: artifactSkill, allowedTools: artifactSkill.tools.map(t => t.name), context: { executionId: 'unrelated-run', projectId, workflowType: 'third-party-agent' },
      request: new Request('http://localhost/mcp/skills/artifact', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }),
    });
    expect(response.status).toBe(200); const body = await response.text();
    return JSON.parse(response.headers.get('content-type')?.includes('text/event-stream') ? body.split('\n').find(line => line.startsWith('data: ')).slice(6) : body);
  };
  const listed = (await serve('tools/list')).result.tools;
  expect(listed.map(t => t.name)).toEqual(expect.arrayContaining(['artifact_comments', 'artifact_comment_replies', 'artifact_comment_reply', 'artifact_comment_resolve']));
  const resolve = listed.find(t => t.name === 'artifact_comment_resolve');
  expect(resolve.description).toContain('Any member with existing project comment permission'); expect(resolve.description).toContain('ONLY when the user explicitly requests'); expect(resolve.description).toContain('must not automatically'); expect(resolve.description).toContain('password is not a member credential');
  expect(resolve.inputSchema.required).toContain('resolved');
  const v1 = await create(); const root = seed(v1.id);
  const result = await serve('tools/call', { name: 'artifact_comment_reply', arguments: { id: v1.id, commentId: root.id, idempotencyKey: 'mcp-reply', text: '通用 agent 回复' } });
  expect(JSON.parse(result.result.content[0].text)).toMatchObject({ duplicate: false, reply: { commentId: root.id, text: '通用 agent 回复' } });
});
