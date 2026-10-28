import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { M1Error } from '../core/errors.js';
import { isRecord } from './cloudflare.js';
import type {
  Answer,
  ChoiceQuestion,
  DecideOptions,
  DecisionProvider,
  DecisionRequest,
  DecisionResponse,
  ProviderConfig,
  Question,
  ScoreQuestion,
} from './types.js';

export const MOCK_DEFAULT_MODEL = 'mock';
const MOCK_USAGE = { input_tokens: 100, output_tokens: 0 };

function synthesizeChoice(question: ChoiceQuestion): Answer {
  const options = Object.keys(question.criteria);
  if (options.length === 0) {
    return { type: 'choice', choice: '', probabilities: {}, confidence: 0 };
  }

  const [first, ...rest] = options;
  const probabilities: Record<string, number> = {};
  if (rest.length === 0) {
    probabilities[first] = 1;
  } else {
    probabilities[first] = 0.72;
    const shared = 0.28 / rest.length;
    for (const option of rest) probabilities[option] = shared;
  }

  return {
    type: 'choice',
    choice: first,
    probabilities,
    confidence: probabilities[first],
  };
}

function synthesizeScore(question: ScoreQuestion): Answer {
  const levels = question.criteria.length;
  if (levels === 0) {
    return { type: 'score', score: 0, probabilities: {}, confidence: 0.66 };
  }

  const score = Math.floor((levels - 1) / 2);
  const probabilities: Record<string, number> = {};
  for (let index = 0; index < levels; index += 1) probabilities[String(index)] = 1 / levels;

  return { type: 'score', score, probabilities, confidence: 0.66 };
}

function synthesize(question: Question): Answer {
  switch (question.type) {
    case 'noul':
      return { type: 'noul', noul: 0.82 };
    case 'choice':
      return synthesizeChoice(question);
    case 'score':
      return synthesizeScore(question);
  }
}

function loadFixtures(dir: string | undefined): Record<string, unknown> {
  if (!dir) return {};

  const file = join(dir, 'answers.json');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new M1Error('E_INPUT', `no se pudo leer el fixture ${file}`, {
      details: (error as Error).message,
      hint: 'revisá provider.fixturesDir',
      cause: error,
    });
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    throw new M1Error('E_PROVIDER', `fixture de mock inválido: ${file}`, {
      details: text.slice(0, 500),
      hint: 'answers.json debe ser un objeto { questionId: Answer }',
      cause: error,
    });
  }
}

export function createMockProvider(name: string, cfg: ProviderConfig): DecisionProvider {
  return {
    name,
    kind: 'mock',
    async evaluate(request: DecisionRequest, _options?: DecideOptions): Promise<DecisionResponse> {
      const fixtures = loadFixtures(cfg.fixturesDir);

      // Refleja exactamente las preguntas pedidas: fixtures parciales + síntesis determinista.
      const answers: Record<string, Answer> = {};
      for (const [questionId, question] of Object.entries(request.questions)) {
        const fixture = fixtures[questionId];
        answers[questionId] = isRecord(fixture)
          ? (fixture as unknown as Answer)
          : synthesize(question);
      }

      return {
        model: cfg.model ?? MOCK_DEFAULT_MODEL,
        answers,
        usage: { ...MOCK_USAGE },
      };
    },
  };
}
