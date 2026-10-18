import { STORY_STATUS } from '@aik/contracts';
import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, evaluate } from '../src/index.ts';
import { ALLOWED_FROM, expectedTo, satisfying } from './fixtures.ts';

describe('transition matrix (spec §16.3)', () => {
  for (const type of EVENT_TYPES) {
    for (const status of STORY_STATUS) {
      const allowed = ALLOWED_FROM[type].includes(status);
      it(`${type} from ${status} is ${allowed ? 'allowed' : 'rejected'}`, () => {
        const { story, evidence, event } = satisfying(type, status);
        const result = evaluate(story, evidence, event);
        if (allowed) {
          expect(result).toMatchObject({ ok: true, from: status, to: expectedTo(type, status) });
        } else {
          expect(result.ok).toBe(false);
          if (!result.ok) expect(result.failedGuards[0]?.guard).toBe('state');
        }
      });
    }
  }
});
