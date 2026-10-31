/** Thin stage-2 adapter. The shared contract owns wire schemas and routes;
 * the backend owns membership, authorship, version checks and delivery. */
import { COMMENT_HTTP_OPERATIONS, CommentListQuerySchema, CommentErrorResponseSchema, ContractError, commentRoutes, bearerHeaders } from '@zibby/artifact-contracts/comment';
import { fetchWithDeadline } from './lib/http-deadline.js';

const idProperty = { type: 'string', minLength: 1, description: 'Explicit artifact id in the project accessible to the current backend session.' };
const threadProperty = { type: 'string', minLength: 1, description: 'Original comment id from artifact_comments. Selects this thread; names and body @ text never select a destination or grant access.' };
const pageProperties = {
  cursor: { type: 'string', minLength: 1, description: 'Opaque nextCursor returned by the same artifact/thread. Omit for its first page.' },
  limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Page size (default 20). A page is not the complete discussion.' },
};

const declarations = [
  {
    name: 'artifact_comments', operation: 'list',
    description: 'Read ONE page of artifact comments, with full original text, sourceVersion/sourceRevisionId, original anchor coordinates, author, resolution, replyCount and actual delivery state/failure. Returns items and nextCursor; continue while nextCursor is non-null to read all comments. Read each thread with artifact_comment_replies; replies are separately paginated. Pins remain on their original version even after artboards are changed or deleted.',
    properties: { id: idProperty, ...pageProperties }, required: ['id'],
  },
  {
    name: 'artifact_comment_replies', operation: 'replies',
    description: 'Read ONE page of full replies in the explicitly selected original comment thread, including authors, designVersion references and actual delivery state. Returns items and nextCursor; continue until null to read all replies. Obtain the root comment, its original version and anchor with artifact_comments, and read that source with artifact_get at sourceVersion. Reading never changes resolution or dispatches work.',
    properties: { id: idProperty, commentId: threadProperty, ...pageProperties }, required: ['id', 'commentId'],
  },
  {
    name: 'artifact_comment_reply', operation: 'reply',
    description: 'Save a reply in the explicitly selected original comment thread. Optional designVersion links a new design receipt, verified by the backend. Returns the saved reply and duplicate flag; saved does not mean an agent was started. Keep the same idempotencyKey and identical content when retrying an uncertain write. Replying or saving a design never resolves/reopens a discussion. Automatic final-answer writeback belongs to the delivery service; do not infer its destination from text, @ mentions or display names.',
    properties: {
      id: idProperty, commentId: threadProperty,
      idempotencyKey: { type: 'string', minLength: 1, description: 'Caller-chosen identity for this reply; reuse only for the identical operation and content.' },
      text: { type: 'string', minLength: 1, description: 'Complete reply body, preserved verbatim. Body @ text has no routing or authorization effect.' },
      designVersion: { type: 'object', additionalProperties: false, description: 'Shared CommentVersionSchema. Copy artifactId, revisionId and version from the confirmed artifact write commit/revision receipt. The backend verifies this immutable version belongs to this artifact.', properties: { artifactId: { type: 'string', minLength: 1 }, revisionId: { type: 'string', minLength: 1 }, version: { type: 'integer', minimum: 1 } }, required: ['artifactId', 'revisionId', 'version'] },
    }, required: ['id', 'commentId', 'idempotencyKey', 'text'],
  },
  {
    name: 'artifact_comment_resolve', operation: 'resolve',
    description: 'Explicitly resolve (resolved:true) or reopen (resolved:false) the selected discussion without deleting its contents. Any member with existing project comment permission may request either action; the backend verifies project membership/access. An external share password is not a member credential. Use ONLY when the user explicitly requests resolving or reopening; a new version, reply or final answer must not automatically change this state.',
    properties: { id: idProperty, commentId: threadProperty, resolved: { type: 'boolean', description: 'Required explicit state: true resolves; false reopens. Never infer it from saving a version or answering.' } }, required: ['id', 'commentId', 'resolved'],
  },
];

export const commentTools = declarations.map(({ name, description, properties, required }) => ({
  name, description, input_schema: { type: 'object', additionalProperties: false, properties, required },
}));
const operations = new Map(declarations.map(({ name, operation }) => [name, operation]));
export const isCommentCall = name => operations.has(name);

export async function handleCommentTool(name, args, { baseUrl, token }) {
  const operation = operations.get(name);
  const spec = COMMENT_HTTP_OPERATIONS[operation];
  try {
    const routes = commentRoutes({ mount: '/credits' });
    const { id, ...parameters } = args || {};
    const { commentId, ...threadParameters } = parameters;
    const input = operation === 'list' ? parameters : threadParameters;
    // Validate the entire command/query, including unknown fields. No caller
    // account, author, role or execution identity is forwarded to the service.
    (spec.request || CommentListQuerySchema).parse(input);
    const route = operation === 'list' ? routes.list(id, input)
      : operation === 'replies' ? routes.replies(id, commentId, input)
      : routes[operation](id, commentId);
    if (!token) return { error: 'Backend session is required to read or change artifact discussions.', code: 'UNAUTHENTICATED', status: 401 };
    const response = await fetchWithDeadline(`${baseUrl}${route}`, {
      method: spec.method, headers: bearerHeaders(token),
      ...(spec.request ? { body: JSON.stringify(input) } : {}),
    }, { kind: 'api', what: 'artifact comment request' });
    let body;
    try { body = await response.json(); } catch {
      return { error: response.ok ? 'Comment service returned invalid JSON.' : `Comment service returned HTTP ${response.status} without a JSON reason.`, code: response.ok ? 'INVALID_COMMENT_RESPONSE' : 'COMMENT_REQUEST_FAILED', status: response.status };
    }
    if (!response.ok) {
      const parsed = CommentErrorResponseSchema.safeParse(body);
      // Older or not-yet-started backends may use an error code outside this
      // contract. Preserve their reason, without forwarding arbitrary fields.
      const failure = parsed.success ? parsed.data.error : body?.error;
      return { error: typeof failure?.message === 'string' ? failure.message : typeof failure === 'string' ? failure : `Comment service returned HTTP ${response.status}.`,
        code: typeof failure?.code === 'string' ? failure.code : typeof body?.code === 'string' ? body.code : 'COMMENT_REQUEST_FAILED', status: response.status };
    }
    const parsed = spec.response.safeParse(body);
    if (!parsed.success) return { error: 'Comment service response did not match the shared contract; no complete page or write receipt was verified.', code: 'INVALID_COMMENT_RESPONSE', status: response.status, issues: parsed.error.issues };
    // Preserve complete bodies, original anchors, cursors and delivery facts.
    return parsed.data;
  } catch (error) {
    if (error instanceof ContractError) return { error: error.message, code: error.code, status: error.status, issues: error.issues };
    // Transport exceptions can contain URLs or credentials; never echo them.
    return { error: 'Artifact comment transport failed; no response was verified. A write may have been saved; retry with the same idempotencyKey and content.', code: 'COMMENT_TRANSPORT_FAILED' };
  }
}
