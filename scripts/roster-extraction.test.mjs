import test from 'node:test';
import assert from 'node:assert/strict';

const { redactRosterText } = await import('../functions/_lib/rosterRedact.ts');
const { validateExtraction, layoversFromExtraction } = await import('../functions/_lib/rosterSchema.ts');
const { extractPdfText } = await import('../functions/_lib/rosterPdf.ts');
const { extractRosterDuties } = await import('../functions/_lib/rosterLlm.ts');

/** Minimal one-page PDF with one text row per entry, top to bottom. */
function pdfWithRows(rows) {
  const stream = rows
    .map((row, index) => `BT /F1 10 Tf 40 ${760 - index * 14} Td (${row}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefAt = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}

const leg = (overrides) => ({
  type: 'flight',
  flight_number: 'SQ322',
  departure_airport: 'SIN',
  arrival_airport: 'LHR',
  arrival_city: 'London',
  scheduled_departure: '2026-10-03T23:30:00+08:00',
  scheduled_arrival: '2026-10-04T06:15:00+01:00',
  confidence: 0.95,
  ...overrides,
});

test('redaction removes people, keeps duty rows', () => {
  const { text, redactedLines } = redactRosterText(
    [
      'Name: TAN Mei Ling   Staff No 123456',
      '03OCT SQ322 SIN 2330 LHR 0615',
      'CP: LEE K  FO - ONG J',
      'Hotel: Park Plaza Westminster',
      'Contact +65 9123 4567 or crew@example.com',
      '05OCT SQ317 LHR 1100 SIN 0730+1',
    ].join('\n'),
  );

  assert.equal(redactedLines, 3);
  assert.match(text, /03OCT SQ322 SIN 2330 LHR 0615/);
  assert.match(text, /05OCT SQ317 LHR 1100 SIN 0730\+1/);
  assert.doesNotMatch(text, /TAN|123456|LEE|Park Plaza|9123|crew@example/);
});

test('validator keeps contract fields and drops malformed values', () => {
  const extraction = validateExtraction({
    home_base: 'sin',
    duties: [
      { ...leg({ flight_number: 'sq 322' }), crew_names: ['TAN'] },
      leg({ scheduled_departure: '2026-10-03 23:30', departure_airport: 'Singapore' }),
    ],
    warnings: ['Times assumed local'],
    passenger: 'dropped',
  });

  assert.equal(extraction.home_base, 'SIN');
  assert.equal(extraction.duties[0].flight_number, 'SQ322');
  assert.equal(extraction.duties[0].scheduled_departure, '2026-10-03T15:30:00.000Z');
  assert.equal('crew_names' in extraction.duties[0], false);
  assert.equal(extraction.duties[1].scheduled_departure, null);
  assert.equal(extraction.duties[1].departure_airport, null);
  assert.equal(validateExtraction({ nope: true }), null);
});

test('layovers come from consecutive legs away from base', () => {
  const extraction = validateExtraction({
    home_base: 'SIN',
    duties: [
      leg({}),
      leg({
        flight_number: 'SQ317',
        departure_airport: 'LHR',
        arrival_airport: 'SIN',
        arrival_city: 'Singapore',
        scheduled_departure: '2026-10-05T11:00:00+01:00',
        scheduled_arrival: '2026-10-06T07:30:00+08:00',
      }),
      leg({
        flight_number: 'SQ856',
        departure_airport: 'SIN',
        arrival_airport: 'HKG',
        arrival_city: 'Hong Kong',
        scheduled_departure: '2026-10-08T09:00:00+08:00',
        scheduled_arrival: '2026-10-08T12:50:00+08:00',
      }),
      leg({
        flight_number: 'SQ857',
        departure_airport: 'HKG',
        arrival_airport: 'SIN',
        scheduled_departure: '2026-10-08T14:10:00+08:00',
        scheduled_arrival: '2026-10-08T18:05:00+08:00',
      }),
      { ...leg({ type: 'off' }), flight_number: null },
    ],
    warnings: [],
  });

  const layovers = layoversFromExtraction(extraction);
  assert.equal(layovers.length, 1, 'HKG turnaround is too short to be a layover');
  assert.deepEqual(layovers[0], {
    flightNumber: 'SQ322',
    departureAirport: 'SIN',
    arrivalAirport: 'LHR',
    layoverCity: 'London',
    layoverStart: '2026-10-04T05:15:00.000Z',
    layoverEnd: '2026-10-05T10:00:00.000Z',
  });
});

test('pdf text keeps one printed row per line', async () => {
  const { text, pages } = await extractPdfText(
    pdfWithRows(['Name: TAN Mei Ling', '03OCT SQ322 SIN 2330 LHR 0615', '05OCT SQ317 LHR 1100 SIN 0730']),
    20,
  );
  assert.equal(pages, 1);
  assert.deepEqual(text.split('\n'), [
    'Name: TAN Mei Ling',
    '03OCT SQ322 SIN 2330 LHR 0615',
    '05OCT SQ317 LHR 1100 SIN 0730',
  ]);
});

test('gemini call sends redacted text with the schema and parses the reply', async (t) => {
  process.env.ROSTER_LLM_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.ROSTER_LLM_MODEL = 'gemini-3.1-flash-lite';
  let request;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    request = { url, init, body: JSON.parse(init.body) };
    return new Response(
      JSON.stringify({
        candidates: [
          { content: { parts: [{ text: JSON.stringify({ home_base: 'SIN', duties: [leg({})], warnings: [] }) }] } },
        ],
        usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 300 },
      }),
      { status: 200 },
    );
  });

  const result = await extractRosterDuties({ kind: 'text', text: '03OCT SQ322 SIN 2330 LHR 0615' });

  assert.match(request.url, /models\/gemini-3\.1-flash-lite:generateContent$/);
  assert.equal(request.init.headers['x-goog-api-key'], 'test-key');
  assert.equal(request.body.generationConfig.responseMimeType, 'application/json');
  assert.ok(request.body.generationConfig.responseJsonSchema.properties.duties);
  assert.equal('temperature' in request.body.generationConfig, false);
  assert.equal(result.extraction.duties[0].flight_number, 'SQ322');
  assert.equal(result.inputTokens, 1200);
});

test('gemini failures map to roster error codes', async (t) => {
  process.env.ROSTER_LLM_PROVIDER = 'gemini';
  process.env.GEMINI_API_KEY = 'test-key';

  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 429 }));
  await assert.rejects(extractRosterDuties({ kind: 'text', text: 'x' }), { code: 'ROSTER_PARSER_BUSY' });

  t.mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }), { status: 200 }),
  );
  await assert.rejects(extractRosterDuties({ kind: 'text', text: 'x' }), { code: 'ROSTER_PARSE_INVALID' });

  process.env.GEMINI_API_KEY = '';
  await assert.rejects(extractRosterDuties({ kind: 'text', text: 'x' }), { code: 'ROSTER_PARSER_UNAVAILABLE' });
});
