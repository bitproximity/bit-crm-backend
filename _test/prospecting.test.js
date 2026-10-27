// Búsqueda de decisores (Prospección B2B): Lusha ahora por la API V3 y mensajes claros cuando Lusha o Apollo rechazan la petición.
const path = require('path');
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) process.exitCode = 1; };
const { createFakeDb, install } = require('./fakeSupabase');
const fake = createFakeDb();
const restore = install(fake);

// node-fetch se reemplaza por una versión que registra las peticiones y devuelve lo que le indiquemos
const calls = [];
let nextResponse = null;
const fakeFetch = async (url, opts = {}) => {
  calls.push({ url, method: opts.method, headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null });
  const r = typeof nextResponse === 'function' ? nextResponse(url) : nextResponse;
  return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => { if (r.noBody) throw new Error('sin cuerpo'); return r.body; } };
};
const nf = require.resolve('node-fetch');
require.cache[nf] = { id: nf, filename: nf, loaded: true, exports: fakeFetch };

const pn = require('../src/routes/prospectingNative');
process.env.LUSHA_API_KEY = 'lusha-test-key';
process.env.APOLLO_API_KEY = 'apollo-test-key';

const respond = (body, status = 200, extra = {}) => { nextResponse = { status, body, ...extra }; calls.length = 0; };
const fail = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// Respuesta de ejemplo de la API V3 de Lusha (mismo formato que su documentación)
const LUSHA_V3 = {
  requestId: 'fa828378-7a8e-4e5d-9f72-0270e7f7ab51',
  pagination: { page: 0, size: 25, total: 60 },
  results: [
    { id: '670138733', firstName: 'Ting', lastName: 'Tsou', jobTitle: { title: 'Gerente de Marketing', departments: ['Marketing'], seniority: 'Manager' }, company: { id: '1', name: 'Ventura Mall', domain: 'venturamall.com' }, location: { country: 'Panama', city: 'Ciudad de Panamá' }, socialLinks: { linkedin: 'https://linkedin.com/in/ting' }, has: ['emails'], canReveal: [{ field: 'emails', credits: 1 }] },
    { id: '555', firstName: 'Ana', lastName: 'Ríos', jobTitle: { title: 'Directora Comercial' }, company: { name: 'Ventura Mall' }, location: {} },
    { id: '777', firstName: 'Bloqueado', lastName: 'GDPR', error: { code: 'COMPLIANCE_RESTRICTED', message: 'x' } },
  ],
  billing: { creditsCharged: 2, resultsReturned: 3 },
};

(async () => {
  // ── 1) Lusha: la petición va a la API V3 con el formato nuevo ───────────────────────────────────
  respond(LUSHA_V3);
  await pn.lushaSearch({ department: 'Marketing', country: 'Panama', company: 'Ventura Mall', sizes: ['51,200'], page: 1 });
  const c = calls[0];
  ok(c.url === 'https://api.lusha.com/v3/contacts/prospecting' && c.method === 'POST', 'Lusha: la petición va a /v3/contacts/prospecting (ya no al endpoint antiguo que respondía 410)');
  ok(!calls.some((x) => /\/prospecting\/contact\/search/.test(x.url)), 'ninguna petición usa el endpoint antiguo');
  ok(c.headers.api_key === 'lusha-test-key', 'la clave viaja en la cabecera api_key');
  ok(c.body.pagination.page === 0 && c.body.pagination.size === 25 && !('pages' in c.body), 'paginación V3: pagination {page desde 0, size 25} (no «pages»)');
  ok(JSON.stringify(c.body.filters.contacts.include) === JSON.stringify({ departments: ['Marketing'], locations: [{ country: 'Panama' }] }), 'filtros de contacto: departamentos y país');
  ok(JSON.stringify(c.body.filters.companies.include) === JSON.stringify({ names: ['Ventura Mall'], sizes: [{ min: 51, max: 200 }] }), 'filtros de empresa: nombre y tamaño como {min, max}');
  ok(c.body.options.includePartialProfiles === true, 'incluye perfiles parciales (como el comportamiento anterior)');
  respond(LUSHA_V3); await pn.lushaSearch({ department: 'Sales', page: 3 });
  ok(calls[0].body.pagination.page === 2 && !calls[0].body.filters.companies && !calls[0].body.filters.contacts.include.locations, 'la página 3 se pide como page 2; sin empresa ni país no se envían esos filtros');
  respond(LUSHA_V3); await pn.lushaSearch({ department: 'Sales, Marketing ,', page: 1 });
  ok(JSON.stringify(calls[0].body.filters.contacts.include.departments) === JSON.stringify(['Sales', 'Marketing']), 'varios departamentos separados por coma');

  // ── 2) Lusha: la respuesta V3 se convierte en las tarjetas de la pantalla ───────────────────────
  respond(LUSHA_V3);
  let out = await pn.lushaSearch({ department: 'Marketing', country: 'Panama', page: 1 });
  ok(out.candidates.length === 2, 'los resultados con error (p. ej. bloqueado por GDPR) se descartan: 2 de 3');
  const t = out.candidates[0];
  ok(t.key === 'lusha:670138733' && t.source === 'lusha' && t.externalId === '670138733' && t.firstName === 'Ting' && t.lastName === 'Tsou', 'identificador y nombre');
  ok(t.title === 'Gerente de Marketing' && t.companyName === 'Ventura Mall' && t.country === 'Panama' && t.linkedinUrl === 'https://linkedin.com/in/ting', 'cargo (viene como objeto en V3), empresa, país y LinkedIn');
  ok(out.candidates[1].title === 'Directora Comercial' && out.candidates[1].country === 'Panama' && out.candidates[1].linkedinUrl === null, 'un contacto con datos mínimos no rompe nada (el país cae al filtro usado)');
  ok(out.total === 60 && out.hasMore === true, 'total 60: hay más páginas');
  respond({ ...LUSHA_V3, pagination: { page: 2, size: 25, total: 60 } }); out = await pn.lushaSearch({ department: 'Marketing', page: 3 });
  ok(out.hasMore === false, 'en la última página (3 × 25 ≥ 60) ya no hay más');
  respond({ pagination: { total: 0 }, results: [] }); out = await pn.lushaSearch({ department: 'Marketing', page: 1 });
  ok(out.candidates.length === 0 && out.total === 0 && out.hasMore === false, 'sin resultados → lista vacía (la pantalla dice «amplía los filtros»)');
  respond({}); out = await pn.lushaSearch({ department: 'Marketing', page: 1 });
  ok(out.candidates.length === 0 && out.total === null, 'una respuesta sin «results» no revienta');

  // ── 3) Lusha: validaciones y errores con mensajes que dicen qué hacer ───────────────────────────
  let e = await fail(() => pn.lushaSearch({ department: '', page: 1 })); ok(e && e.message === 'Escribe al menos un departamento.', 'sin departamento → pide uno');
  const k = process.env.LUSHA_API_KEY; delete process.env.LUSHA_API_KEY;
  e = await fail(() => pn.lushaSearch({ department: 'Sales', page: 1 })); ok(e && /falta la variable LUSHA_API_KEY/.test(e.message), 'sin clave configurada → dice qué variable falta'); process.env.LUSHA_API_KEY = k;
  const casos = [[401, 'inválida o fue revocada'], [402, 'no tiene créditos'], [403, 'no tiene acceso a esta API'], [410, 'retiró la API antigua'], [429, 'limitó las peticiones'], [451, 'normativa de datos']];
  for (const [status, frase] of casos) {
    respond({ statusCode: status, message: 'detalle de Lusha' }, status); e = await fail(() => pn.lushaSearch({ department: 'Sales', page: 1 }));
    ok(e && e.message.includes(frase) && e.message.includes('detalle de Lusha') && !/^Lusha respondió/.test(e.message), `Lusha ${status} → mensaje claro con el detalle de Lusha`);
  }
  respond({ message: 'boom' }, 500); e = await fail(() => pn.lushaSearch({ department: 'Sales', page: 1 })); ok(e && e.message === 'Lusha respondió 500: boom', 'un error no previsto conserva el código y el detalle');
  respond(null, 502, { noBody: true }); e = await fail(() => pn.lushaSearch({ department: 'Sales', page: 1 })); ok(e && e.message === 'Lusha respondió 502: error desconocido', 'una respuesta sin cuerpo tampoco rompe el manejo de errores');
  ok(pn.lushaErrorMessage(410, { message: 'V2 API access is not available for this account.' }).includes('V2 API access is not available'), 'el mensaje exacto del error 410 que viste ahora explica qué pasó');

  // ── 4) Apollo: su plan gratuito no incluye la búsqueda por API ──────────────────────────────────
  const APOLLO_403 = { error: 'The api/v1/mixed_people/api_search API is not included in your Free plan and is not accessible, even with a master key. All paid plans include full API access. Upgrade your plan from https://www.apollo.io/pricing' };
  respond(APOLLO_403, 403); e = await fail(() => pn.apolloSearch({ title: 'Gerente de marketing', page: 1 }));
  ok(e && /plan gratuito no incluye la búsqueda de personas por API/.test(e.message) && /apollo\.io\/pricing/.test(e.message) && /Usa Lusha/.test(e.message) && !/mixed_people/.test(e.message), 'Apollo 403 (plan gratuito) → explica que hace falta un plan de pago y sugiere Lusha, sin el texto técnico');
  respond({ error: 'Invalid access credentials' }, 401); e = await fail(() => pn.apolloSearch({ title: 'CEO', page: 1 })); ok(e && /API key de Apollo es inválida/.test(e.message), 'Apollo 401 → clave inválida');
  respond({ error: 'rate' }, 429); e = await fail(() => pn.apolloSearch({ title: 'CEO', page: 1 })); ok(e && /limitó las peticiones/.test(e.message), 'Apollo 429 → límite de peticiones');
  respond({ error: 'otra cosa' }, 403); e = await fail(() => pn.apolloSearch({ title: 'CEO', page: 1 })); ok(e && e.message === 'Apollo respondió 403: otra cosa', 'un 403 de Apollo que NO es del plan conserva su detalle');
  e = await fail(() => pn.apolloSearch({ title: '', page: 1 })); ok(e && e.message === 'Escribe al menos un cargo.', 'Apollo sin cargo → pide uno');
  respond({ people: [{ id: 'a1', first_name: 'Luis', last_name_obfuscated: 'Pa***z', title: 'CMO', organization: { name: 'Acme' }, linkedin_url: 'https://l.in/x' }], pagination: { total_entries: 1, total_pages: 1 } });
  out = await pn.apolloSearch({ title: 'CMO', country: 'Mexico', page: 1 });
  ok(out.candidates[0].key === 'apollo:a1' && out.candidates[0].lastName === 'Pa***z' && out.candidates[0].companyName === 'Acme' && out.hasMore === false && calls[0].headers['x-api-key'] === 'apollo-test-key', 'Apollo con plan de pago: la búsqueda sigue funcionando igual que antes');

  // ── 5) El manejador HTTP: lo que recibe la pantalla ─────────────────────────────────────────────
  const call = async (body) => { let r = { status: 200, json: null }; await pn.search({ body, teamMember: { id: 'u1', role: 'admin' } }, { status(s) { r.status = s; return this; }, json(j) { r.json = j; return this; } }); return r; };
  respond(LUSHA_V3);
  let r = await call({ provider: 'lusha', department: 'Marketing', country: 'Panama', company: 'Ventura Mall', sizes: [], page: 1 });
  ok(r.status === 200 && r.json.candidates.length === 2 && r.json.page === 1 && r.json.hasMore === true && r.json.total === 60 && r.json.pageSize === 25, 'respuesta a la pantalla: contactos, página, «hay más», total y tamaño de página');
  ok(r.json.candidates.every((x) => 'key' in x && 'firstName' in x && 'title' in x && 'companyName' in x), 'cada contacto trae los campos que la pantalla pinta');
  respond({ message: 'V2 API access is not available for this account. Migrate to V3' }, 410);
  r = await call({ provider: 'lusha', department: 'Marketing', page: 1 });
  ok(r.status === 400 && /Lusha retiró la API antigua/.test(r.json.error), 'un error de Lusha llega a la pantalla como 400 con mensaje claro (no un 500 genérico)');
  respond(APOLLO_403, 403);
  r = await call({ provider: 'apollo', title: 'Gerente', page: 1 });
  ok(r.status === 400 && /plan gratuito/.test(r.json.error), 'el error de Apollo también llega claro');
  respond(LUSHA_V3); r = await call({ provider: 'lusha', department: 'Sales', page: 9999 });
  ok(calls[0].body.pagination.page === 199, 'la página se limita a 200 (pagination.page 199)');

  restore();
})();
