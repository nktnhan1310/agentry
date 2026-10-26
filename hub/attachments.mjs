// Screenshots on tickets (bug reports). Stored in the ticket dir; copied into the worktree only for the plan step.
// Token cost: Claude reads an image at ~1 token per 28×28 px, so the UI downscales to IMAGE_MAX_EDGE first
// (1568×882 ≈ 1.8k tokens vs ≈ 4.8k at the 2576px model limit). Only the planner sees images; the coder gets text.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { createTicket, event, ticketFile, updateTicket } from './store.mjs';

export const IMAGE_MAX_EDGE = 1568;
export const IMAGE_LIMITS = { count: 6, bytes: 4 * 1024 * 1024 };
export const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

const dir = (id) => ticketFile(id, 'attachments');
export const listAttachments = (id) => (existsSync(dir(id)) ? readdirSync(dir(id)).filter((f) => IMAGE_TYPES[extname(f).slice(1).toLowerCase()]).sort() : []);
export const attachmentPath = (id, name) => join(dir(id), name);

// items: [{ data: Buffer }]. Type is checked by magic bytes, not the file name.
export function checkImages(items, existing = 0) {
  if (existing + items.length > IMAGE_LIMITS.count) throw new Error(`at most ${IMAGE_LIMITS.count} images per ticket`);
  for (const { data } of items) {
    if (!sniff(data)) throw new Error('only PNG, JPEG, WebP or GIF images are allowed');
    if (data.length > IMAGE_LIMITS.bytes) throw new Error(`image too large (${(data.length / 1048576).toFixed(1)} MB > ${IMAGE_LIMITS.bytes / 1048576} MB)`);
  }
}

export function saveAttachments(id, items) {
  const existing = listAttachments(id);
  checkImages(items, existing.length);
  mkdirSync(dir(id), { recursive: true });
  let n = existing.length;
  return items.map(({ data }) => {
    const name = `img-${++n}.${sniff(data)}`;
    writeFileSync(attachmentPath(id, name), data);
    return name;
  });
}

// Validate first, create parked in the backlog, write the images, then queue: the daemon never starts a
// ticket whose screenshots are still being written.
export function createWithImages(opts, items = []) {
  checkImages(items);
  if (!items.length) return createTicket(opts);
  const t = createTicket({ ...opts, status: 'backlog' });
  saveAttachments(t.id, items);
  return updateTicket(t.id, (x) => { x.status = opts.status || 'ready'; event(x, `${items.length} screenshot(s) attached`); });
}

export function fromDataUrl(s) {
  const m = /^data:image\/[\w.+-]+;base64,(.+)$/s.exec(String(s || ''));
  if (!m) throw new Error('image must be a base64 data URL');
  return { data: Buffer.from(m[1], 'base64') };
}
export const fromFile = (p) => {
  if (!existsSync(p)) throw new Error(`no such image: ${p}`);
  return { data: readFileSync(p) };
};

function sniff(b) {
  if (b.length < 12) return '';
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (b.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  return '';
}

// Copy into <worktree>/.kit/handoff/<id>/ (git-excluded) so the read-only planner can open them with Read.
export function stageAttachments(t) {
  const names = listAttachments(t.id);
  if (!names.length || !t.worktree) return [];
  const rel = `.kit/handoff/${t.id}`;
  mkdirSync(join(t.worktree, rel), { recursive: true });
  return names.map((n) => { copyFileSync(attachmentPath(t.id, n), join(t.worktree, rel, n)); return `${rel}/${n}`; });
}
