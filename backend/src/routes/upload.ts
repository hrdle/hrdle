import { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TMP_PATHS } from '../../../shared/identity';

const upload = new Hono();

// Directory for uploaded images (accessible from terminal sessions on this host)
const UPLOAD_DIR = TMP_PATHS.imagesDir;

async function ensureUploadDir() {
  try {
    await mkdir(UPLOAD_DIR, { recursive: true });
  } catch {
    // already exists
  }
}

function generateFilename(originalName: string): string {
  const ext = originalName.split('.').pop()?.toLowerCase() || 'png';
  const id = randomBytes(8).toString('hex');
  const timestamp = Date.now();
  return `${timestamp}-${id}.${ext}`;
}

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_SIZE = 10 * 1024 * 1024;

export interface UploadedImage {
  path: string;
  filename: string;
}

/**
 * Persist an uploaded image file to this host's UPLOAD_DIR.
 * Returns a host-local absolute path that the local agent (Claude Code etc.)
 * can read directly.
 */
export async function saveUploadedImage(file: File): Promise<UploadedImage> {
  if (!ALLOWED_TYPES.includes(file.type)) {
    throw new Error('Invalid file type. Allowed: PNG, JPEG, GIF, WebP');
  }
  if (file.size > MAX_SIZE) {
    throw new Error('File too large. Max 10MB');
  }

  await ensureUploadDir();

  const filename = generateFilename(file.name);
  const filepath = join(UPLOAD_DIR, filename);
  const buffer = await file.arrayBuffer();
  await writeFile(filepath, Buffer.from(buffer));

  return { path: filepath, filename };
}

upload.post('/image', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('image');

    if (!file || !(file instanceof File)) {
      return c.json({ error: 'No image file provided' }, 400);
    }

    const result = await saveUploadedImage(file);
    return c.json({ success: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to upload image';
    const status = /Invalid file type|too large/.test(message) ? 400 : 500;
    if (status === 500) console.error('Upload error:', err);
    return c.json({ error: message }, status);
  }
});

export { upload };
