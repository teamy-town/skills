/** Versioned designs use the shared protocol; HTML validation stays on the server. */
import { randomUUID, webcrypto } from 'node:crypto';
import { createDesignClient, MAX_SNAPSHOT_BYTES, SCHEMA_VERSION } from '@zibby/artifact-contracts';
import { fetchWithDeadline } from './lib/http-deadline.js';

export const designProperties = {
  artifactType: { type: 'string', enum: ['design'], description: 'Explicitly selects versioned design transport; ordinary JSON text remains a file.' },
  projectId: { type: 'string', description: 'Owning project id. Inside a run it defaults to the run\'s own project; pass it only to write to another project. The server checks access using the backend session.' },
  design: { type: 'object', description: `Shared DesignSnapshotSchema: {artifactType:"design",schemaVersion:${SCHEMA_VERSION},artboards:[{id,name,width,height,x,y,html}]}. Full editable source, at most ${MAX_SNAPSHOT_BYTES} UTF-8 JSON bytes in total. Only initial publish fills missing board IDs; retain returned IDs on updates.` },
  operations: { type: 'array', items: { type: 'object' }, description: 'Shared OperationsSchema: add {op:"add",artboard:{id,name,width,height,x,y,html}}, remove {op:"remove",artboardId}, update {op:"update",artboardId,changes:{name?,width?,height?,html?}}, move {op:"move",artboardId,x,y}. Mutually exclusive with design. IDs stay stable.' },
  baseVersion: { type: 'integer', minimum: 1, description: 'Required for design update/restore. Use the version you read; a conflict requires reading current state and deciding again.' },
};
export const designVersionProperty = { type: 'integer', minimum: 1, description: 'Immutable design version; omit on get for latest. Required on restore: the old version to copy into a new revision.' };
export const designInlineProperty = { type: 'boolean', description: 'Design get only: true returns the whole snapshot (every board\'s html) in this answer. By default inside a run the answer is the board index and the whole design arrives in this run as a JSON file; use inline when this run cannot read files.' };

/**
 * WHAT A DESIGN READ HANDS THE MODEL (run fbb8cbf2, 2026-11-03: two reads of a
 * 27-board design returned ~615 KB each, 34% of the run's tool output, carried
 * through every later request). Inside a run the answer is the board index —
 * every board's id, name, size, position and html bytes — and the whole
 * snapshot is brought into the run as a JSON file through the same mailbox door
 * artifact_open uses; the model reads what it needs with its own tools. Nothing
 * is withheld: `inline: true` returns the whole snapshot here, and a call with
 * no run (nothing to bring a file into) or whose file could not be sent gets
 * the whole snapshot as before.
 */
export async function designReadAnswer(read, { inline = false, bringIntoRun = undefined }: { inline?: boolean; bringIntoRun?: (file: { id: string; name: string; version?: number }, text: string) => Promise<unknown> } = {}) {
  if (inline || typeof bringIntoRun !== 'function') return read;
  const snapshot = read.revision.snapshot;
  const version = read.revision.metadata.version;
  const id = read.artifact.id;
  const name = `design-${id}-v${version}.json`;
  const artboards = snapshot.artboards.map(({ html, ...board }) => ({ ...board, htmlBytes: Buffer.byteLength(html, 'utf8') }));
  try {
    await bringIntoRun({ id, name, version }, `The design you read with artifact_get: ${read.artifact.title || id}, version ${version}, as a file`);
  } catch {
    return { ...read, fileWarning: 'The design could not be sent into this run as a file, so the whole snapshot is in this answer.' };
  }
  return {
    artifact: read.artifact,
    revision: { metadata: read.revision.metadata, artboards },
    snapshotFile: {
      name,
      bytes: Buffer.byteLength(JSON.stringify(snapshot), 'utf8'),
      contains: `The whole design of version ${version}: {artifactType, schemaVersion, artboards:[{id,name,width,height,x,y,html}]}, every board with its html, the editable source.`,
      arrives: 'A message in this turn names the file\'s local path, usually within 20 seconds; read the boards you need from it with your own tools. If it cannot be opened, that message says why. artifact_get with inline:true returns the whole snapshot in an answer instead.',
    },
  };
}

export const designTools = [
  {
    name: 'artifact_versions',
    description: 'List one page of immutable design revision metadata, including authors and summaries. Returns items and nextCursor; pass the cursor to continue.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, cursor: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['id'] },
  },
  {
    name: 'artifact_restore',
    description: 'Restore a design version as a NEW revision without changing history. Requires baseVersion and version; returns confirmed commit and separate readBack status. Never replay a confirmed write after a read-back failure; artifact_get at commit.revision.version recovers its full source.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, baseVersion: designProperties.baseVersion, version: designVersionProperty, summary: { type: 'string' } }, required: ['id', 'baseVersion', 'version'] },
  },
];

export function designClient({ baseUrl, token }) {
  // The protocol uses standard SubtleCrypto.digest; Node and DOM type libraries
  // disagree on unrelated generateKey overloads.
  return createDesignClient({ baseUrl, token, mount: '/credits', crypto: webcrypto as unknown as Crypto,
    fetch: (url, init) => fetchWithDeadline(url, init, { kind: new Headers(init?.headers).has('authorization') ? 'api' : 'transfer', what: 'design artifact transport' }),
  });
}

export function isDesignCall(name, args) {
  return name === 'artifact_versions' || name === 'artifact_restore'
    || (['artifact_publish', 'artifact_update', 'artifact_get'].includes(name)
      && (args?.artifactType === 'design' || args?.design !== undefined || args?.operations !== undefined))
    || (name === 'artifact_get' && args?.version !== undefined);
}

/** Only safe structured facts are returned; exceptions may contain signed object URLs. */
export function designError(error) {
  const out: any = { error: 'Design request failed; no commit was confirmed by this call.', code: error?.code || 'DESIGN_REQUEST_FAILED' };
  if (Number.isInteger(error?.status)) out.status = error.status;
  if (Array.isArray(error?.issues)) out.issues = error.issues;
  if (Array.isArray(error?.details?.issues)) out.issues = error.details.issues;
  if (Array.isArray(error?.details?.defects)) out.defects = error.details.defects;
  if (out.code === 'VERSION_CONFLICT') {
    out.baseVersion = error.baseVersion;
    out.currentVersion = error.currentVersion;
    out.instruction = 'Read the current design with artifact_get, then decide how to revise it using that baseVersion. This write was not replayed.';
  }
  if (out.code === 'CONTENT_TOO_LARGE') {
    out.maxSnapshotBytes = MAX_SNAPSHOT_BYTES;
    out.error = `The complete design exceeds ${MAX_SNAPSHOT_BYTES} UTF-8 JSON bytes across all artboards.`;
  }
  return out;
}

export async function handleDesignTool(name, args, { baseUrl, token, indexRecall, indexStore, ownerNamespace, runProjectId = undefined, bringIntoRun = undefined }) {
  // A run is never told its project id; without this default the model guessed (2026-11-03, run 9d6b8743 passed its
  // execution id three times). The run's own project is the default; an explicit projectId still wins.
  if (['artifact_publish', 'artifact_update'].includes(name) && args && (typeof args.projectId !== 'string' || !args.projectId.trim()) && runProjectId) args = { ...args, projectId: runProjectId };
  const invalid = (error) => ({ error, code: 'INVALID_STRUCTURE', status: 400 });
  const legacyContent = ['html', 'markdown', 'text', 'data', 'contentType', 'share', 'kind', 'favicon', 'description', 'uploadId'];
  if (name === 'artifact_restore' && [...legacyContent, 'design', 'operations'].some(k => args?.[k] !== undefined)) return invalid('Restore selects an existing version; do not combine it with new content.');
  if (['artifact_publish', 'artifact_update'].includes(name)) {
    if (args?.artifactType !== 'design') return invalid('artifactType: "design" is required with design or operations.');
    if (legacyContent.some(k => args[k] !== undefined)) {
      return invalid('Design calls cannot contain document/text, report data, or legacy sharing fields. Use design OR operations and the versioned design tools.');
    }
    if ((args.design !== undefined) === (args.operations !== undefined)) return invalid('Pass exactly one of design or operations.');
    if (name === 'artifact_publish' && (args.operations !== undefined || args.baseVersion !== undefined || args.id !== undefined)) return invalid('Initial publish requires a full design and omits id/baseVersion/operations.');
    if (typeof args.projectId !== 'string' || !args.projectId.trim()) return invalid('projectId is required for design publish/update (this call does not know its run\'s project).');
    if (name === 'artifact_update' && !Number.isSafeInteger(args.baseVersion)) return invalid('baseVersion is required for a design update.');
    if (name === 'artifact_publish' && (typeof args.title !== 'string' || !args.title.trim())) return invalid('title is required.');
  }
  if (name !== 'artifact_publish' && (typeof args?.id !== 'string' || !args.id.trim())) return invalid('id is required.');
  const client = designClient({ baseUrl, token });
  if (name === 'artifact_get') return designReadAnswer(await client.get(args.id, args.version), { inline: args.inline === true, bringIntoRun });
  if (name === 'artifact_versions') return client.versions(args.id, { ...(args.cursor === undefined ? {} : { cursor: args.cursor }), ...(args.limit === undefined ? {} : { limit: args.limit }) });

  // Capture the existing record before writing; an index outage cannot erase a confirmed commit.
  let prior: any = {};
  let recallFailed = false;
  if (name !== 'artifact_publish') {
    try { prior = await indexRecall(args.id, { strict: true }) || {}; } catch { recallFailed = true; }
  }
  let written;
  if (name === 'artifact_restore') {
    written = await client.restore(args.id, { baseVersion: args.baseVersion, version: args.version, ...(args.summary === undefined ? {} : { summary: args.summary }) });
  } else {
    // Generate IDs ONCE for the initial snapshot only. The shared schemas validate every update.
    const snapshot = name === 'artifact_publish' && Array.isArray(args.design?.artboards)
      ? { ...args.design, artboards: args.design.artboards.map(board => board && typeof board === 'object' ? { ...board, ...(board.id === undefined ? { id: randomUUID() } : {}) } : board) }
      : args.design;
    const command = { projectId: args.projectId, ...(args.title === undefined ? {} : { title: args.title }), ...(args.summary === undefined ? {} : { summary: args.summary }),
      ...(args.operations === undefined ? { snapshot } : { operations: args.operations }),
      ...(name === 'artifact_publish' ? {} : { id: args.id, baseVersion: args.baseVersion }),
    };
    written = await client[name === 'artifact_publish' ? 'create' : args.operations === undefined ? 'replace' : 'patch'](command);
  }
  // The client returns no signed capabilities. Version and IDs come only from its confirmed receipt.
  const out: any = { ...written, id: written.commit.artifactId };
  if (written.readBack.status !== 'verified') out.instruction = 'The write is committed. Do not repeat it. Recover editable source with artifact_get using artifactType:"design", id:commit.artifactId and version:commit.revision.version.';
  if (recallFailed) {
    out.indexWarning = 'The design is committed, but the existing index could not be read; its ownership and creation time were left unchanged.';
    return out;
  }
  const record: any = { ...prior, id: written.commit.artifactId, artifactType: 'design', currentVersion: written.commit.currentVersion,
    revisionId: written.commit.revision.revisionId,
    ownerNamespace: prior.ownerNamespace || ownerNamespace,
    title: written.artifact?.title || args.title || prior.title,
    createdAt: prior.createdAt || written.artifact?.createdAt || (name === 'artifact_publish' ? written.commit.revision.createdAt : undefined),
    updatedAt: written.commit.revision.createdAt,
    summary: args.summary ?? prior.summary ?? args.title,
  };
  try { await indexStore(out.id, record, record.ownerNamespace); } catch { out.indexWarning = 'The design is committed, but its index could not be saved. Do not repeat the write.'; }
  return out;
}
