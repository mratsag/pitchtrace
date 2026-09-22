import type { DraftOutput } from './schema.js';

export function renderBody(draft: DraftOutput): string {
  return [draft.greeting, '', ...draft.claims.map((c) => c.text), '', draft.closing]
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
