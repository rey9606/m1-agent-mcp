import { z } from 'zod';

/**
 * Sobre de entrada de una corrida. Es lo que la IA/CLI arma a partir de
 * `--input archivo.json`, `--state-file`, `--image` o `--stdin`.
 * Las imágenes pueden venir como path local, data URL o {content_type, base64}.
 */
export const imageInputSchema = z.union([
  z.string().min(1),
  z.object({
    content_type: z.string().optional(),
    base64: z.string().min(1),
  }),
]);
export type RawImageInput = z.infer<typeof imageInputSchema>;

export const runInputSchema = z.record(z.string(), z.unknown());
export type RunInput = z.infer<typeof runInputSchema>;

export const runOptionsSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  dryRun: z.boolean().default(false),
  trace: z.boolean().default(false),
  timeoutMs: z.number().int().positive().optional(),
  concurrency: z.number().int().positive().max(16).default(4),
});
export type RunOptions = z.infer<typeof runOptionsSchema>;
