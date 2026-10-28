import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validateRecipe } from '../src/core/validate.js';
import {
  explainWorkflow,
  renderExplainMermaid,
  renderExplainText,
  type ExplainedWorkflow,
} from '../src/workflows/explain.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function load(name: string): ExplainedWorkflow {
  const path = join(REPO, 'examples', `${name}.json`);
  const { recipe } = validateRecipe(JSON.parse(readFileSync(path, 'utf8')), {
    defaultId: name,
    filePath: path,
  });
  return explainWorkflow({
    recipe,
    name,
    builtin: true,
    path,
    description: recipe.description ?? '',
  });
}

describe('explainWorkflow', () => {
  it('describe las etapas en orden, con su condición y su state propio', () => {
    const explained = load('ux-checker');

    expect(explained.stages.map((stage) => stage.id)).toEqual(['base', 'diagnostico']);
    expect(explained.stages[0]?.when).toBeNull();
    expect(explained.stages[0]?.ownState).toBe(false);
    expect(explained.stages[1]?.when).toBe('UX-1 < 0.5 || UX-2 < 0.7');
    expect(explained.stages[1]?.ownState).toBe(true);
    expect(explained.stages[1]?.questions).toEqual(['UX-5']);
  });

  it('resuelve los niveles de un score a 0..1 y marca desde qué nivel se aprueba', () => {
    const explained = load('ux-checker');
    const ux1 = explained.criteria.find((criterion) => criterion.id === 'UX-1');

    expect(ux1?.type).toBe('score');
    expect(ux1?.options.map((option) => option.normalized)).toEqual([0, 1 / 3, 2 / 3, 1]);
    expect(ux1?.passesFrom?.value).toBe('2');
  });

  it('usa el mapping de un choice y deja null cuando no lo declara', () => {
    const explained = load('ux-checker');
    const ux3 = explained.criteria.find((criterion) => criterion.id === 'UX-3');
    const ux5 = explained.criteria.find((criterion) => criterion.id === 'UX-5');

    expect(ux3?.options.find((option) => option.value === 'parcial')?.normalized).toBe(0.55);
    expect(ux5?.options.every((option) => option.normalized !== null)).toBe(true);
  });

  it('arma un ejemplo de invocación con el slot de texto y la imagen', () => {
    const explained = load('ux-checker');

    expect(explained.example.command).toBe(
      'm1 run ux-checker --image ./pantalla.png --slot brief "..." --json',
    );
  });

  it('elige el slot de texto requerido cuando hay varios text', () => {
    const explained = load('copy-checker');

    expect(explained.example.command).toBe('m1 run copy-checker --slot copy "..." --json');
  });
});

describe('renderExplainText', () => {
  const text = renderExplainText(load('ux-checker'));

  it('incluye etapas, condición, criterios y acceptance', () => {
    expect(text).toContain('ETAPAS (2)');
    expect(text).toContain('sólo si: UX-1 < 0.5 || UX-2 < 0.7');
    expect(text).toContain('CRITERIOS (5)');
    expect(text).toContain('severidad blocker');
    expect(text).toContain('A1');
    expect(text).toContain('quality >= 0.72');
  });

  it('explica las reglas del veredicto en vez de dejarlas implícitas', () => {
    expect(text).toContain('reglas del veredicto');
    expect(text).toContain('acceptance blocker o major incumplido → fail');
  });
});

describe('renderExplainMermaid', () => {
  const mermaid = renderExplainMermaid(load('ux-checker'));

  it('produce un flowchart con entrada, etapas, agregación y veredicto', () => {
    expect(mermaid.startsWith('flowchart TD\n')).toBe(true);
    expect(mermaid).toContain('IN["entrada');
    expect(mermaid).toContain('S1["base');
    expect(mermaid).toContain('AGG["agregación');
    expect(mermaid).toContain('V(["pass · fail · needs_review"])');
  });

  it('escapa los operadores de la condición y dibuja el camino "si no"', () => {
    expect(mermaid).toContain('UX-1 &lt; 0.5 || UX-2 &lt; 0.7');
    expect(mermaid).toContain('-->|"si no"| AGG');
  });

  it('conecta la acceptance con el veredicto sólo si existe', () => {
    expect(mermaid).toContain('AGG --> ACC{"acceptance');
    expect(mermaid).toContain('ACC -->|"no cumple"| V');
  });
});