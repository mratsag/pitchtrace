import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchPsiFieldData, parsePsiResponse } from '../../src/audit/psi.js';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

const SAMPLE = {
  loadingExperience: {
    overall_category: 'SLOW',
    metrics: {
      LARGEST_CONTENTFUL_PAINT_MS: { percentile: 5200, category: 'SLOW' },
      CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 32 },
      INTERACTION_TO_NEXT_PAINT: { percentile: 410 },
    },
  },
};

await test('PSI yanıtı alan verisine ayrıştırılır', () => {
  const parsed = parsePsiResponse(SAMPLE);
  assert.deepEqual(parsed, {
    source: 'crux',
    lcpMs: 5200,
    clsScore: 0.32,
    inpMs: 410,
    overallCategory: 'SLOW',
  });
});

await test('alan verisi yoksa null döner', () => {
  assert.equal(parsePsiResponse({}), null);
  assert.equal(parsePsiResponse({ loadingExperience: {} }), null);
  assert.equal(parsePsiResponse({ loadingExperience: { metrics: {} } }), null);
});

await test('API anahtarı yoksa HİÇBİR istek yapılmaz', async () => {
  let called = 0;
  const result = await fetchPsiFieldData('https://ornek.test/', {
    apiKey: '',
    fetchImpl: async () => {
      called += 1;
      return jsonResponse(SAMPLE);
    },
  });
  assert.equal(result, null);
  assert.equal(called, 0, 'anahtar yokken ağ çağrısı yapılmamalı');
});

await test('anahtar varsa istek yapılır ve veri döner', async () => {
  const seen: string[] = [];
  const result = await fetchPsiFieldData('https://ornek.test/sayfa', {
    apiKey: 'test-key',
    fetchImpl: async (url) => {
      seen.push(url);
      return jsonResponse(SAMPLE);
    },
  });
  assert.equal(result?.lcpMs, 5200);
  assert.equal(seen.length, 1);
  assert.ok(seen[0]!.includes('strategy=mobile'));
  assert.ok(seen[0]!.includes(encodeURIComponent('https://ornek.test/sayfa')));
  assert.ok(seen[0]!.includes('key=test-key'));
});

await test('hatalı yanıt, bozuk gövde ve ağ hatası sessizce null döner', async () => {
  assert.equal(
    await fetchPsiFieldData('https://ornek.test/', {
      apiKey: 'k',
      fetchImpl: async () => jsonResponse({}, false, 429),
    }),
    null,
  );

  assert.equal(
    await fetchPsiFieldData('https://ornek.test/', {
      apiKey: 'k',
      fetchImpl: async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error('bozuk JSON');
          },
        }) as unknown as Response,
    }),
    null,
  );

  assert.equal(
    await fetchPsiFieldData('https://ornek.test/', {
      apiKey: 'k',
      fetchImpl: async () => {
        throw new Error('ağ hatası');
      },
    }),
    null,
  );
});
