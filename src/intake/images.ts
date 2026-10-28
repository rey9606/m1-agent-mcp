import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { M1Error } from '../core/errors';

/**
 * Límites duros de la API (Clef). Están acá y no en config porque si la API
 * los cambia, cambia el contrato: no son un parámetro de la receta.
 */
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_TOTAL_DECODED_BYTES = 8 * 1024 * 1024;
export const MAX_REQUEST_BODY_BYTES = 13 * 1024 * 1024;
export const MAX_MEGAPIXELS = 16;

export const SUPPORTED_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type SupportedImageMime = (typeof SUPPORTED_IMAGE_MIMES)[number];

export interface LoadedImage {
  content_type: string;
  base64: string;
  bytes: number;
  source: string;
  width?: number;
  height?: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function startsWith(buf: Buffer, bytes: Buffer): boolean {
  return buf.length >= bytes.length && buf.subarray(0, bytes.length).equals(bytes);
}

/** Detecta el tipo real por magic bytes. No confía en el `content_type` declarado. */
export function sniffMime(buf: Buffer): SupportedImageMime | undefined {
  if (startsWith(buf, PNG_SIGNATURE)) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (
    buf.length >= 12 &&
    buf.toString('latin1', 0, 4) === 'RIFF' &&
    buf.toString('latin1', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return undefined;
}

function pngSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24) return undefined;
  if (buf.toString('latin1', 12, 16) !== 'IHDR') return undefined;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width === 0 || height === 0) return undefined;
  return { width, height };
}

/** JPEG: recorre markers hasta el primer SOFn (SOF0..SOF15 salvo DHT/JPG/DAC). */
function jpegSize(buf: Buffer): { width: number; height: number } | undefined {
  let p = 2;
  while (p + 3 < buf.length) {
    if (buf[p] !== 0xff) return undefined;
    let marker = buf[p + 1];
    // Bytes de relleno 0xFF antes del marker real.
    while (marker === 0xff) {
      p += 1;
      if (p + 1 >= buf.length) return undefined;
      marker = buf[p + 1];
    }
    // Standalone markers: sin longitud.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      p += 2;
      continue;
    }
    if (p + 4 > buf.length) return undefined;
    const len = buf.readUInt16BE(p + 2);
    if (len < 2) return undefined;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (p + 9 > buf.length) return undefined;
      const height = buf.readUInt16BE(p + 5);
      const width = buf.readUInt16BE(p + 7);
      if (width === 0 || height === 0) return undefined;
      return { width, height };
    }
    p += 2 + len;
  }
  return undefined;
}

function webpSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 30) return undefined;
  const fourcc = buf.toString('latin1', 12, 16);
  if (fourcc === 'VP8X') {
    // flags(1) + reserved(3) + canvas_width_minus_1(3 LE) + canvas_height_minus_1(3 LE)
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width, height };
  }
  if (fourcc === 'VP8 ') {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return undefined;
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    if (width === 0 || height === 0) return undefined;
    return { width, height };
  }
  if (fourcc === 'VP8L') {
    if (buf[20] !== 0x2f) return undefined;
    const bits = buf.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return { width, height };
  }
  return undefined;
}

/** Dimensiones para PNG/JPEG (y WebP cuando el header lo permite). Nunca lanza. */
export function imageSize(buf: Buffer, mime: string): { width: number; height: number } | undefined {
  switch (mime) {
    case 'image/png':
      return pngSize(buf);
    case 'image/jpeg':
      return jpegSize(buf);
    case 'image/webp':
      return webpSize(buf);
    default:
      return undefined;
  }
}

/** `data:image/png;base64,....` → partes. Sólo acepta la forma base64. */
export function parseDataUrl(value: string): { content_type: string; base64: string } | undefined {
  const match = /^data:([^,]*),([\s\S]*)$/.exec(value);
  if (!match) return undefined;
  const meta = match[1] ?? '';
  const payload = match[2] ?? '';
  const params = meta.split(';').map((s) => s.trim());
  const isBase64 = params.some((p) => p.toLowerCase() === 'base64');
  const mediaType = params[0] && !params[0].includes('base64') ? params[0].toLowerCase() : '';
  let base64 = payload;
  if (!isBase64) {
    try {
      base64 = Buffer.from(decodeURIComponent(payload), 'latin1').toString('base64');
    } catch {
      return undefined;
    }
  }
  if (base64.length === 0) return undefined;
  return { content_type: mediaType || 'application/octet-stream', base64 };
}

export function toDataUrl(img: { content_type: string; base64: string }): string {
  return `data:${img.content_type};base64,${img.base64}`;
}

function normalizeMime(value: string): string {
  const mime = value.trim().toLowerCase();
  return mime === 'image/jpg' ? 'image/jpeg' : mime;
}

function isSupportedMime(value: string): value is SupportedImageMime {
  return (SUPPORTED_IMAGE_MIMES as readonly string[]).includes(value);
}

/** Decodifica/carga una imagen y valida que sea png/jpeg/webp real (por magic bytes). */
export async function loadImage(
  raw: string | { content_type?: string; base64: string },
  opts: { cwd?: string } = {},
): Promise<LoadedImage> {
  let buf: Buffer;
  let declared: string | undefined;
  let source: string;

  if (typeof raw === 'string') {
    if (raw.startsWith('data:')) {
      const parsed = parseDataUrl(raw);
      if (!parsed) {
        throw new M1Error('E_INPUT', 'data URL de imagen inválida', {
          hint: 'el formato esperado es data:image/png;base64,<datos>',
        });
      }
      buf = Buffer.from(parsed.base64, 'base64');
      declared = parsed.content_type === 'application/octet-stream' ? undefined : parsed.content_type;
      source = 'data-url';
    } else {
      const resolved = path.resolve(opts.cwd ?? process.cwd(), raw);
      try {
        buf = await readFile(resolved);
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          throw new M1Error('E_INPUT', `imagen no encontrada: ${raw}`, {
            hint: 'pasá una ruta existente o una data URL',
            cause,
          });
        }
        throw new M1Error('E_INPUT', `no se pudo leer la imagen: ${raw}`, {
          hint: 'verificá permisos y que la ruta apunte a un archivo',
          cause,
        });
      }
      source = resolved;
    }
  } else if (raw && typeof raw === 'object' && typeof raw.base64 === 'string') {
    if (raw.base64.length === 0) {
      throw new M1Error('E_INPUT', 'la imagen tiene base64 vacío', {
        hint: 'pasá el contenido de la imagen codificado en base64',
      });
    }
    buf = Buffer.from(raw.base64, 'base64');
    declared = raw.content_type;
    source = 'inline';
  } else {
    throw new M1Error('E_INPUT', 'entrada de imagen inválida', {
      hint: 'usá un path, una data URL o { content_type?, base64 }',
    });
  }

  const sniffed = sniffMime(buf);
  if (!sniffed) {
    throw new M1Error('E_INPUT', 'formato de imagen no soportado', {
      hint: 'sólo se aceptan png, jpeg o webp',
    });
  }

  if (declared !== undefined) {
    const mime = normalizeMime(declared);
    if (!isSupportedMime(mime)) {
      throw new M1Error('E_INPUT', `tipo de imagen no soportado: ${declared}`, {
        hint: 'sólo se aceptan png, jpeg o webp',
      });
    }
    if (mime !== sniffed) {
      throw new M1Error(
        'E_INPUT',
        `el content_type declarado (${mime}) no coincide con el contenido real (${sniffed})`,
        { hint: 'omití content_type y se detecta solo, o corregí el valor' },
      );
    }
  }

  const size = imageSize(buf, sniffed);
  const loaded: LoadedImage = {
    content_type: sniffed,
    base64: buf.toString('base64'),
    bytes: buf.length,
    source,
  };
  if (size) {
    loaded.width = size.width;
    loaded.height = size.height;
  }
  return loaded;
}

/** Valida cantidad, peso por imagen, total decodificado y megapíxeles. */
export function assertImageBudget(images: LoadedImage[]): void {
  if (images.length > MAX_IMAGES) {
    throw new M1Error('E_INPUT', `se enviaron ${images.length} imágenes; el máximo es ${MAX_IMAGES}`, {
      hint: `reducí a ${MAX_IMAGES} imágenes o menos`,
      details: { images: images.length, limit: MAX_IMAGES },
    });
  }

  let total = 0;
  for (const [index, img] of images.entries()) {
    if (img.bytes > MAX_IMAGE_BYTES) {
      throw new M1Error(
        'E_INPUT',
        `la imagen ${index + 1} (${img.source}) pesa ${img.bytes} bytes; el máximo por imagen es ${MAX_IMAGE_BYTES} bytes (4 MiB)`,
        {
          hint: 'comprimí o redimensioná la imagen antes de enviarla',
          details: { index, source: img.source, bytes: img.bytes, limit: MAX_IMAGE_BYTES },
        },
      );
    }
    total += img.bytes;
    if (img.width !== undefined && img.height !== undefined) {
      const pixels = img.width * img.height;
      if (pixels > MAX_MEGAPIXELS * 1_000_000) {
        const megapixels = pixels / 1_000_000;
        throw new M1Error(
          'E_INPUT',
          `la imagen ${index + 1} (${img.source}) tiene ${megapixels.toFixed(1)} MP (${img.width}x${img.height}); el máximo es ${MAX_MEGAPIXELS} MP`,
          {
            hint: 'redimensioná la imagen a 16 MP o menos',
            details: { index, source: img.source, width: img.width, height: img.height, limit: MAX_MEGAPIXELS },
          },
        );
      }
    }
  }

  if (total > MAX_TOTAL_DECODED_BYTES) {
    throw new M1Error(
      'E_INPUT',
      `las imágenes suman ${total} bytes decodificados; el máximo total es ${MAX_TOTAL_DECODED_BYTES} bytes (8 MiB)`,
      {
        hint: 'reducí cantidad o tamaño de las imágenes',
        details: { total, limit: MAX_TOTAL_DECODED_BYTES },
      },
    );
  }
}

/** Estima el body HTTP (base64 crece ~4/3) y lo compara con el límite de la API. */
export function assertBodyBudget(bodyBytes: number): void {
  if (bodyBytes > MAX_REQUEST_BODY_BYTES) {
    throw new M1Error(
      'E_INPUT',
      `el request estimado son ${bodyBytes} bytes; el máximo es ${MAX_REQUEST_BODY_BYTES} bytes (13 MiB)`,
      {
        hint: 'reducí cantidad/tamaño de imágenes o el state',
        details: { bytes: bodyBytes, limit: MAX_REQUEST_BODY_BYTES },
      },
    );
  }
}
