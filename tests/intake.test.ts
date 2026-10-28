import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MAX_IMAGE_BYTES,
  MAX_REQUEST_BODY_BYTES,
  MAX_TOTAL_DECODED_BYTES,
  assertBodyBudget,
  assertImageBudget,
  imageSize,
  loadImage,
  parseDataUrl,
  sniffMime,
  toDataUrl,
  type LoadedImage,
} from '../src/intake/images';
import { resolveInput } from '../src/intake/input';
import { M1Error } from '../src/core/errors';
import { recipeSchema, type Recipe, type Slot } from '../src/schema/recipe';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function png(width: number, height: number, padding = 0): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8; // bit depth
  ihdr[17] = 2; // truecolor
  ihdr[18] = 0; // compression
  ihdr[19] = 0; // filter
  ihdr[20] = 0; // interlace
  const iend = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([PNG_SIGNATURE, ihdr, iend, Buffer.alloc(padding)]);
}

function jpeg(width: number, height: number): Buffer {
  const sof = Buffer.alloc(19);
  sof[0] = 0xff;
  sof[1] = 0xc0; // SOF0
  sof.writeUInt16BE(17, 2);
  sof[4] = 8; // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3; // components
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

function webpVp8x(width: number, height: number): Buffer {
  const buf = Buffer.alloc(30);
  buf.write('RIFF', 0, 'latin1');
  buf.writeUInt32LE(22, 4);
  buf.write('WEBP', 8, 'latin1');
  buf.write('VP8X', 12, 'latin1');
  buf.writeUInt32LE(10, 16);
  const w = width - 1;
  const h = height - 1;
  buf[24] = w & 0xff;
  buf[25] = (w >> 8) & 0xff;
  buf[26] = (w >> 16) & 0xff;
  buf[27] = h & 0xff;
  buf[28] = (h >> 8) & 0xff;
  buf[29] = (h >> 16) & 0xff;
  return buf;
}

function fakeImage(bytes: number, width?: number, height?: number): LoadedImage {
  const img: LoadedImage = { content_type: 'image/png', base64: 'AA==', bytes, source: 'fake' };
  if (width !== undefined && height !== undefined) {
    img.width = width;
    img.height = height;
  }
  return img;
}

type SlotInput = { type: Slot['type']; required?: boolean; description?: string; max?: number };

function recipeWith(slots: Record<string, SlotInput>, images: string[] = []): Recipe {
  return recipeSchema.parse({
    role: 'reviewer',
    criteria: [{ id: 'c1', type: 'noul', instructions: '¿Está bien?' }],
    stages: [{ id: 's1', questions: ['c1'] }],
    input: { slots, images },
  });
}

describe('images: sniffing y dimensiones', () => {
  it('detecta png, jpeg, webp por magic bytes y rechaza otros', () => {
    expect(sniffMime(png(8, 8))).toBe('image/png');
    expect(sniffMime(jpeg(16, 9))).toBe('image/jpeg');
    expect(sniffMime(webpVp8x(32, 20))).toBe('image/webp');
    expect(sniffMime(Buffer.from('GIF89a....'))).toBeUndefined();
    expect(sniffMime(Buffer.alloc(0))).toBeUndefined();
  });

  it('lee dimensiones de PNG (IHDR) y JPEG (SOF0) y WebP (VP8X)', () => {
    expect(imageSize(png(8, 8), 'image/png')).toEqual({ width: 8, height: 8 });
    expect(imageSize(jpeg(1920, 1080), 'image/jpeg')).toEqual({ width: 1920, height: 1080 });
    expect(imageSize(webpVp8x(640, 480), 'image/webp')).toEqual({ width: 640, height: 480 });
    expect(imageSize(Buffer.from('nope'), 'image/png')).toBeUndefined();
  });

  it('parseDataUrl/toDataUrl hacen round-trip', () => {
    const bytes = png(8, 8);
    const url = toDataUrl({ content_type: 'image/png', base64: bytes.toString('base64') });
    const parsed = parseDataUrl(url);
    expect(parsed?.content_type).toBe('image/png');
    expect(Buffer.from(parsed!.base64, 'base64').equals(bytes)).toBe(true);
    expect(parseDataUrl('no-es-data-url')).toBeUndefined();
  });
});

describe('images: loadImage', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'm1-intake-'));
    await writeFile(path.join(dir, 'captura.png'), png(8, 8));
    await writeFile(path.join(dir, 'mini.jpg'), jpeg(64, 32));
    await writeFile(path.join(dir, 'anim.webp'), webpVp8x(10, 10));
    await writeFile(path.join(dir, 'falsa.png'), Buffer.from('GIF89a....'));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('carga un path relativo usando cwd', async () => {
    const img = await loadImage('captura.png', { cwd: dir });
    expect(img.content_type).toBe('image/png');
    expect(img.bytes).toBe(png(8, 8).length);
    expect(img.source).toBe(path.join(dir, 'captura.png'));
    expect(img.width).toBe(8);
    expect(img.height).toBe(8);
  });

  it('carga un path absoluto y detecta jpeg', async () => {
    const abs = path.join(dir, 'mini.jpg');
    const img = await loadImage(abs);
    expect(img.content_type).toBe('image/jpeg');
    expect(img.width).toBe(64);
    expect(img.height).toBe(32);
  });

  it('carga una data URL', async () => {
    const url = toDataUrl({ content_type: 'image/png', base64: png(8, 8).toString('base64') });
    const img = await loadImage(url);
    expect(img.content_type).toBe('image/png');
    expect(img.source).toBe('data-url');
  });

  it('detecta content_type desde el buffer si falta', async () => {
    const img = await loadImage({ base64: webpVp8x(4, 4).toString('base64') });
    expect(img.content_type).toBe('image/webp');
    expect(img.width).toBe(4);
  });

  it('acepta content_type correcto y normaliza image/jpg', async () => {
    const img = await loadImage({ content_type: 'image/jpg', base64: jpeg(5, 5).toString('base64') });
    expect(img.content_type).toBe('image/jpeg');
  });

  it('falla con un mime no soportado', async () => {
    await expect(loadImage('falsa.png', { cwd: dir })).rejects.toMatchObject({
      code: 'E_INPUT',
    });
    await expect(loadImage('falsa.png', { cwd: dir })).rejects.toThrow(/no soportado/);
  });

  it('falla si el archivo no existe con hint accionable', async () => {
    const err = await loadImage('no-existe.png', { cwd: dir }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(M1Error);
    expect((err as M1Error).code).toBe('E_INPUT');
    expect((err as M1Error).message).toContain('imagen no encontrada: no-existe.png');
    expect((err as M1Error).hint).toContain('ruta existente o una data URL');
  });

  it('falla si el content_type declarado no coincide con el contenido', async () => {
    await expect(
      loadImage({ content_type: 'image/jpeg', base64: png(8, 8).toString('base64') }),
    ).rejects.toThrow(/no coincide con el contenido real/);
  });
});

describe('images: presupuestos', () => {
  it('rechaza más de 4 imágenes', () => {
    const images = Array.from({ length: 5 }, () => fakeImage(100));
    expect(() => assertImageBudget(images)).toThrow(/máximo es 4/);
  });

  it('acepta exactamente 4 imágenes chicas', () => {
    const images = Array.from({ length: 4 }, () => fakeImage(100));
    expect(() => assertImageBudget(images)).not.toThrow();
  });

  it('rechaza una imagen de más de 4 MiB', () => {
    expect(() => assertImageBudget([fakeImage(MAX_IMAGE_BYTES + 1)])).toThrow(/máximo por imagen/);
  });

  it('rechaza un total decodificado de más de 8 MiB', () => {
    const chunk = 3 * 1024 * 1024;
    expect(() => assertImageBudget([fakeImage(chunk), fakeImage(chunk), fakeImage(chunk)])).toThrow(
      /máximo total/,
    );
    expect(MAX_TOTAL_DECODED_BYTES).toBe(8 * 1024 * 1024);
  });

  it('rechaza imágenes de más de 16 MP y no chequea si faltan dimensiones', () => {
    expect(() => assertImageBudget([fakeImage(100, 5000, 5000)])).toThrow(/MP/);
    expect(() => assertImageBudget([fakeImage(100)])).not.toThrow();
  });

  it('rechaza un body HTTP estimado por encima de 13 MiB', () => {
    const err = (() => {
      try {
        assertBodyBudget(MAX_REQUEST_BODY_BYTES + 1);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(M1Error);
    expect((err as M1Error).message).toContain('el máximo es');
    expect((err as M1Error).hint).toContain('reducí cantidad/tamaño de imágenes o el state');
    expect(() => assertBodyBudget(MAX_REQUEST_BODY_BYTES)).not.toThrow();
  });
});

describe('resolveInput', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'm1-resolve-'));
    await writeFile(path.join(dir, 'a.png'), png(8, 8));
    await writeFile(path.join(dir, 'b.png'), png(8, 8));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('falla si un slot obligatorio falta, con tipo y ejemplo en el hint', async () => {
    const recipe = recipeWith({ brief: { type: 'text', required: true } });
    const err = await resolveInput({}, recipe).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(M1Error);
    expect((err as M1Error).message).toBe('falta el slot obligatorio "brief"');
    expect((err as M1Error).hint).toContain('tipo esperado: text');
    expect((err as M1Error).hint).toContain('"brief"');
  });

  it('falla si un slot text viene vacío o con otro tipo', async () => {
    const recipe = recipeWith({ brief: { type: 'text' } });
    await expect(resolveInput({ brief: '   ' }, recipe)).rejects.toThrow(/string no vacío/);
    await expect(resolveInput({ brief: 42 }, recipe)).rejects.toThrow(/slot "brief"/);
  });

  it('acepta cualquier valor en un slot json', async () => {
    const recipe = recipeWith({ meta: { type: 'json', required: true } });
    const out = await resolveInput({ meta: { tags: ['a'], n: 1 } }, recipe);
    expect(out.vars.meta).toEqual({ tags: ['a'], n: 1 });
    expect(out.imagesBySlot).toEqual({});
  });

  it('falla si la entrada no es un objeto plano', async () => {
    const recipe = recipeWith({});
    const err = await resolveInput('brief.png', recipe).catch((e: unknown) => e);
    expect((err as M1Error).code).toBe('E_INPUT');
    expect((err as M1Error).hint).toBe('se esperaba un objeto JSON con los slots');
    await expect(resolveInput([1, 2], recipe)).rejects.toBeInstanceOf(M1Error);
    await expect(resolveInput(null, recipe)).rejects.toBeInstanceOf(M1Error);
  });

  it('carga un slot image desde path relativo', async () => {
    const recipe = recipeWith({ shot: { type: 'image', required: true } });
    const out = await resolveInput({ shot: 'a.png' }, recipe, { cwd: dir });
    expect(out.imagesBySlot.shot).toHaveLength(1);
    expect(out.imagesBySlot.shot[0]!.content_type).toBe('image/png');
    expect(out.vars.shot).toBe('a.png');
  });

  it('carga un slot image[] con 2 imágenes y las agrupa por slot', async () => {
    const recipe = recipeWith({ shots: { type: 'image[]', max: 4 } });
    const raw = { shots: ['a.png', path.join(dir, 'b.png')] };
    const out = await resolveInput(raw, recipe, { cwd: dir });
    expect(out.imagesBySlot.shots).toHaveLength(2);
    expect(out.imagesBySlot.shots.every((i) => i.content_type === 'image/png')).toBe(true);
    expect(out.vars).toEqual(raw);
  });

  it('falla si image[] no es array o supera el máximo del slot', async () => {
    const recipe = recipeWith({ shots: { type: 'image[]', max: 1 } });
    await expect(resolveInput({ shots: 'a.png' }, recipe, { cwd: dir })).rejects.toThrow(
      /array de 1 a 1/,
    );
    await expect(
      resolveInput({ shots: ['a.png', 'b.png'] }, recipe, { cwd: dir }),
    ).rejects.toThrow(/hasta 1 imágenes/);
  });

  it('falla si un elemento de image[] no es una referencia válida', async () => {
    const recipe = recipeWith({ shots: { type: 'image[]' } });
    await expect(resolveInput({ shots: [{ base64: '' }] }, recipe, { cwd: dir })).rejects.toThrow(
      /shots\[0\]/,
    );
  });

  it('ignora slots no declarados pero los devuelve en vars', async () => {
    const recipe = recipeWith({ brief: { type: 'text', required: true } });
    const out = await resolveInput({ brief: 'hola', extra: { libre: true } }, recipe);
    expect(out.vars).toEqual({ brief: 'hola', extra: { libre: true } });
    expect(out.imagesBySlot).toEqual({});
  });

  it('es determinista entre llamadas con la misma entrada', async () => {
    const recipe = recipeWith({ shot: { type: 'image' } });
    const first = await resolveInput({ shot: 'a.png' }, recipe, { cwd: dir });
    const second = await resolveInput({ shot: 'a.png' }, recipe, { cwd: dir });
    expect(second).toEqual(first);
  });

  it('aplica el presupuesto de imágenes a nivel global entre slots', async () => {
    const recipe = recipeWith({
      one: { type: 'image' },
      two: { type: 'image' },
      three: { type: 'image' },
      four: { type: 'image' },
      five: { type: 'image' },
    });
    const raw = {
      one: 'a.png',
      two: 'a.png',
      three: 'a.png',
      four: 'a.png',
      five: 'a.png',
    };
    await expect(resolveInput(raw, recipe, { cwd: dir })).rejects.toThrow(/máximo es 4/);
  });
});
