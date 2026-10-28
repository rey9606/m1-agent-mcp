import { workflowSkeleton } from './store';

export interface WorkflowGuideSection {
  id: string;
  title: string;
  body: string;
  commands?: string[];
}

/**
 * Guía de autoría pensada para que un agente escriba un workflow válido de
 * una sola vez. El esqueleto es el mismo que genera `m1 workflow new`.
 */
export const WORKFLOW_GUIDE_SECTIONS: WorkflowGuideSection[] = [
  {
    id: 'formato',
    title: 'Formato general',
    body:
      'Un workflow es un único objeto JSON. Campos: id (nombre, igual al archivo), role, description, ' +
      'whenToUse, provider (opcional), input, criteria, stages y, opcionalmente, derived, acceptance y limits. ' +
      'No hay texto libre: el motor sólo responde preguntas tipadas.',
  },
  {
    id: 'entrada',
    title: 'Entrada (input.slots)',
    body:
      'Declará cada slot con type: text, json, image o image[]. Marcá required sólo lo imprescindible. ' +
      'input.state es la plantilla que ve el modelo; usá {{slot}} para insertar valores. ' +
      'Para imágenes declaradas en input.images, el motor las adjunta a la etapa.',
    commands: [
      'm1 run <workflow> --state "texto" --json',
      'm1 run <workflow> --input entrada.json --json',
      'm1 run <workflow> --image pantalla.png --timeout 300000 --json',
    ],
  },
  {
    id: 'criterios',
    title: 'Criterios (criteria)',
    body:
      'Cada criterio tiene id único, type y instructions. noul = sí/no; choice = una opción de un objeto ' +
      'id → descripción (2..255); score = array ordenado de niveles (2..10). Ajustá passAt (0..1), weight, ' +
      'severity (blocker|major|minor|info), polarity (negative invierte) y remediation (acción concreta).',
  },
  {
    id: 'etapas',
    title: 'Etapas (stages)',
    body:
      'Cada etapa es una llamada al modelo con 1..64 preguntas. Poné juntas las preguntas independientes y ' +
      'en etapas posteriores las que dependen de respuestas previas. when (opcional) saltea la etapa; ' +
      'state/images (opcionales) sobreescriben la plantilla del workflow.',
  },
  {
    id: 'aceptacion',
    title: 'Aceptación y derivados',
    body:
      'derived calcula índices numéricos en orden. acceptance define las condiciones duras: ' +
      'blocker/major reprobadas dan fail; minor/info dan needs_review. Ejemplo: "calidad >= 0.66". ' +
      'Los ids con guiones necesitan espacios al restar: UX-1 - 0.5.',
  },
  {
    id: 'checklist',
    title: 'Checklist para crearlo',
    body:
      '1) m1 workflow new <nombre> --from copy-checker (o sin --from para el esqueleto). ' +
      '2) Editá el JSON en ~/.config/m1-agent/workflows/<nombre>.json. ' +
      '3) m1 workflow validate <nombre>. 4) m1 run <nombre> --print-request. ' +
      '5) m1 run <nombre> --state "..." --json. Si el verdict es fail, aplicá issues[].remediation.',
    commands: [
      'm1 workflow new mi-copy --from copy-checker',
      'm1 workflow validate mi-copy',
      'm1 run mi-copy --print-request',
      'm1 run mi-copy --state "texto a evaluar" --json',
    ],
  },
  {
    id: 'reglas',
    title: 'Reglas que evitan errores',
    body:
      'Un criterio debe aparecer en alguna etapa. No referencies un derived posterior. ' +
      'No uses ids que empiecen con dígito sin corchetes en expresiones. ' +
      'Máximo 64 preguntas por etapa, 255 opciones y 10 niveles. ' +
      'El id del workflow debe coincidir con el nombre del archivo y no puede repetirse con un built-in.',
  },
  {
    id: 'comandos',
    title: 'Comandos de workflows',
    body:
      'list muestra nombre y descripción; show el JSON; new crea; import/export mueven archivos; ' +
      'edit abre el editor; delete borra (los built-in son de sólo lectura); validate y schema validan el formato; ' +
      'guide es esta ayuda. run acepta el nombre, sin ruta ni .json.',
    commands: [
      'm1 workflow list',
      'm1 workflow new mi-copy --description "Evalúa copy de landing"',
      'm1 workflow import ./workflow.json --name mi-copy',
      'm1 workflow export mi-copy --out ./mi-copy.json',
      'm1 workflow delete mi-copy --yes',
    ],
  },
];

export function workflowGuidePayload() {
  return {
    ok: true,
    sections: WORKFLOW_GUIDE_SECTIONS,
    skeleton: workflowSkeleton('mi-workflow', {
      description: 'Describí en una línea qué evalúa este workflow.',
    }),
  };
}