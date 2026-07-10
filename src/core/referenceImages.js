import fs from 'node:fs/promises';
import path from 'node:path';

export const REFERENCE_LIMITS = Object.freeze({
  maxFiles: 4,
  maxFileBytes: 6 * 1024 * 1024,
  maxTotalBytes: 18 * 1024 * 1024,
  minDimension: 1,
  maxDimension: 4096,
});

const TYPES = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
]);

export function normalizeReferencePayloads(payloads = []) {
  if (!Array.isArray(payloads)) {
    throw coded('REFERENCE_INVALID', 'references must be an array');
  }
  if (payloads.length > REFERENCE_LIMITS.maxFiles) {
    throw coded(
      'REFERENCE_COUNT_EXCEEDED',
      `at most ${REFERENCE_LIMITS.maxFiles} reference images are allowed`,
    );
  }

  let total = 0;
  const names = new Set();
  return payloads.map((payload, index) => {
    const type = String(payload?.type ?? '').toLowerCase();
    const ext = TYPES.get(type);
    if (!ext) {
      throw coded(
        'REFERENCE_TYPE_UNSUPPORTED',
        `unsupported reference type: ${type || '(empty)'}`,
      );
    }

    const buffer = decodeBase64(payload?.base64);
    if (buffer.length > REFERENCE_LIMITS.maxFileBytes) {
      throw coded('REFERENCE_TOO_LARGE', `reference ${index + 1} exceeds 6 MiB`);
    }
    total += buffer.length;
    if (total > REFERENCE_LIMITS.maxTotalBytes) {
      throw coded('REFERENCE_TOTAL_EXCEEDED', 'reference images exceed 18 MiB total');
    }

    const actual = readImageDimensions(buffer, type);
    const claimedWidth = Number(payload?.width);
    const claimedHeight = Number(payload?.height);
    if (actual.width !== claimedWidth || actual.height !== claimedHeight) {
      throw coded(
        'REFERENCE_DIMENSION_MISMATCH',
        'reference dimensions do not match file content',
      );
    }
    if (
      actual.width < REFERENCE_LIMITS.minDimension
      || actual.height < REFERENCE_LIMITS.minDimension
      || actual.width > REFERENCE_LIMITS.maxDimension
      || actual.height > REFERENCE_LIMITS.maxDimension
    ) {
      throw coded('REFERENCE_DIMENSION_INVALID', 'reference dimensions are outside 1..4096');
    }

    const baseName = sanitizeName(payload?.name, index, ext);
    const stem = path.basename(baseName, ext);
    let name = baseName;
    for (let suffix = 2; names.has(name); suffix += 1) {
      name = `${stem}-${suffix}${ext}`;
    }
    names.add(name);
    return {
      name,
      type,
      width: actual.width,
      height: actual.height,
      bytes: buffer.length,
      buffer,
    };
  });
}

export async function writeReferencePayloads(inputDir, references) {
  const dir = path.join(inputDir, 'references');
  await fs.mkdir(dir, { recursive: true });
  for (const reference of references) {
    await fs.writeFile(path.join(dir, reference.name), reference.buffer);
  }
  const manifest = references.map(({ name, type, width, height, bytes }) => ({
    name,
    type,
    width,
    height,
    bytes,
  }));
  await fs.writeFile(
    path.join(dir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );
}

export async function discoverReferenceImages(inputDir) {
  const dir = path.join(inputDir, 'references');
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (!Array.isArray(manifest)) {
    throw coded('REFERENCE_MANIFEST_INVALID', 'reference manifest must be an array');
  }
  return Promise.all(manifest.map(async (item) => {
    const file = resolveReferenceFile(dir, item.name);
    return {
      ...item,
      file,
      buffer: await fs.readFile(file),
    };
  }));
}

export function referenceContentPart(reference) {
  return {
    type: 'image_url',
    image_url: {
      url: `data:${reference.type};base64,${reference.buffer.toString('base64')}`,
    },
  };
}

function decodeBase64(value) {
  const text = String(value ?? '').replace(/\s+/g, '');
  if (!text || !/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw coded('REFERENCE_INVALID', 'reference base64 is invalid');
  }
  return Buffer.from(text, 'base64');
}

function sanitizeName(value, index, ext) {
  const original = String(value || `reference-${index + 1}`);
  const stem = path.basename(original, path.extname(original))
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return `${stem || `reference-${index + 1}`}${ext}`;
}

function coded(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function resolveReferenceFile(dir, name) {
  const candidate = String(name ?? '');
  const absoluteOnAnyPlatform = path.posix.isAbsolute(candidate)
    || path.win32.isAbsolute(candidate);
  const resolved = path.resolve(dir, candidate);
  const relative = path.relative(dir, resolved);
  if (
    !candidate
    || absoluteOnAnyPlatform
    || relative.startsWith('..')
    || path.isAbsolute(relative)
  ) {
    throw coded('REFERENCE_PATH_INVALID', `reference path is outside its directory: ${candidate}`);
  }
  return resolved;
}

function readImageDimensions(buffer, type) {
  if (type === 'image/png') {
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) {
      throw coded('REFERENCE_INVALID', 'PNG signature is invalid');
    }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }

  if (type === 'image/jpeg') {
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
      throw coded('REFERENCE_INVALID', 'JPEG signature is invalid');
    }
    for (let offset = 2; offset + 9 < buffer.length;) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      if ([
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
        0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
      ].includes(marker)) {
        return {
          height: buffer.readUInt16BE(offset + 5),
          width: buffer.readUInt16BE(offset + 7),
        };
      }
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) break;
      offset += 2 + length;
    }
    throw coded('REFERENCE_INVALID', 'JPEG dimensions are missing');
  }

  if (type === 'image/webp') {
    if (
      buffer.length < 30
      || buffer.toString('ascii', 0, 4) !== 'RIFF'
      || buffer.toString('ascii', 8, 12) !== 'WEBP'
    ) {
      throw coded('REFERENCE_INVALID', 'WebP signature is invalid');
    }
    const chunk = buffer.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3),
      };
    }
    if (chunk === 'VP8L') {
      const bits = buffer.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    if (chunk === 'VP8 ') {
      return {
        width: buffer.readUInt16LE(26) & 0x3fff,
        height: buffer.readUInt16LE(28) & 0x3fff,
      };
    }
    throw coded('REFERENCE_INVALID', 'WebP dimensions are missing');
  }

  throw coded('REFERENCE_TYPE_UNSUPPORTED', `unsupported reference type: ${type}`);
}
