// scripts/fetch_recipes.js
// Node 18+. Descarga recipes*.json desde ao-data (API GitHub) de forma robusta,
// lo decodifica (si viene en base64) y genera formatos plano/CSV.

const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT_DIR       = path.join(process.cwd(), 'data');
const OUT_JSON      = path.join(OUT_DIR, 'recipes.json');
const OUT_FLAT_JSON = path.join(OUT_DIR, 'recipes.flat.json');
const OUT_FLAT_CSV  = path.join(OUT_DIR, 'recipes.flat.csv');

// Repos candidatos (por si uno cambia/cae)
const CANDIDATE_REPOS = [
  { owner: 'ao-data',         repo: 'ao-bin-dumps',   branch: 'master' },
  { owner: 'broderickhyman',  repo: 'ao-bin-dumps',   branch: 'master' },
];

const TOKEN = process.env.GITHUB_TOKEN || '';

function httpGet(url, headers = {}) {
  const h = { ...headers };
  if (!h['User-Agent']) h['User-Agent'] = 'AlbionCalc-RecipesSync/1.0 (+github-actions)';
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: h }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        resolve({ ok, code: res.statusCode, headers: res.headers, body, url });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function maybeDecodeGithubContent(body) {
  // Si viene de contents API con {content: "...", encoding:"base64"}
  try {
    const o = JSON.parse(body);
    if (o && o.content && /base64/i.test(o.encoding || '')) {
      return Buffer.from(o.content, 'base64').toString('utf8');
    }
  } catch (_e) { /* no era JSON o no tenía content */ }
  return body;
}

// === Normalización de recetas a filas planas ===
function g(obj, keys, def = '') {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) return obj[k];
  }
  return def;
}

function toFlatRows(recipes) {
  const out = [];
  for (const r of recipes) {
    const outId   = g(r, ['OutputObject','OutputItem','OutputItemId','output','UniqueName','ItemId'], '');
    const outQty  = Number(g(r, ['OutputAmount','OutputQuantity','OutputQty','amount','quantity','NumProduced','OutputCount'], 1)) || 1;
    const station = g(r, ['CraftingCategory','Station','station','building','CraftingStation'], '') || 'recipes.json';
    const focus   = !!g(r, ['FocusBased','Focus','focusBased','focus'], false);
    const inputs  = g(r, ['Ingredients','ingredients','EntryRequirements','craftingRequirements','Materials','crafting','CraftingRequirements'], []);

    if (!outId) continue;

    if (Array.isArray(inputs) && inputs.length) {
      for (const ing of inputs) {
        const inId  = g(ing, ['Object','Item','ItemId','item','UniqueName','id'], '');
        const inQty = Number(g(ing, ['Count','Amount','amount','count','qty','Quantity'], 1)) || 1;
        if (inId) out.push({ OUTPUT_ID: outId, OUTPUT_QTY: outQty, INPUT_ID: inId, INPUT_QTY: inQty, STATION: station, FOCUS_BASED: focus ? 1 : 0 });
      }
    } else {
      out.push({ OUTPUT_ID: outId, OUTPUT_QTY: outQty, INPUT_ID: '', INPUT_QTY: 0, STATION: station, FOCUS_BASED: focus ? 1 : 0 });
    }
  }
  return out;
}

// === Descubrimiento dinámico del archivo recipes*.json en /formatted ===
async function findRecipesMetaViaContentsAPI() {
  const baseHeaders = {
    'Accept': 'application/vnd.github+json',
    ...(TOKEN ? { 'Authorization': `token ${TOKEN}` } : {})
  };

  for (const { owner, repo, branch } of CANDIDATE_REPOS) {
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/formatted?ref=${branch}`;
    const { ok, code, body } = await httpGet(url, baseHeaders);
    if (!ok) continue;

    try {
      const list = JSON.parse(body);
      if (Array.isArray(list)) {
        // Busca el primer recipes*.json
        const hit = list.find(e => e && e.type === 'file' && /^recipes.*\.json$/i.test(String(e.name || '')));
        if (hit) {
          return {
            owner, repo, branch,
            name: hit.name,
            download_url: hit.download_url || null,
            api_url: hit.url || null
          };
        }
      }
    } catch (_) { /* ignorar y probar siguiente repo */ }
  }
  return null;
}

async function fetchTextFromApiOrDownload(meta) {
  const apiHeaders = {
    'Accept': 'application/vnd.github+json',
    ...(TOKEN ? { 'Authorization': `token ${TOKEN}` } : {})
  };
  const rawHeaders = {
    'Accept': '*/*',
    ...(TOKEN ? { 'Authorization': `token ${TOKEN}` } : {})
  };

  // 1) Si hay download_url, úsalo primero (suele evitar límites de tamaño de contents API)
  if (meta.download_url) {
    const r = await httpGet(`${meta.download_url}?_=${Date.now()}`, rawHeaders);
    if (r.ok) return r.body;
  }

  // 2) Si hay api_url, prueba contents API y decodifica base64 si aplica
  if (meta.api_url) {
    const r = await httpGet(`${meta.api_url}?ref=${meta.branch}&_=${Date.now()}`, apiHeaders);
    if (r.ok) return maybeDecodeGithubContent(r.body);
  }

  throw new Error('No pude obtener el archivo desde la API ni por download_url.');
}

async function fetchWithFallbacks(owner, repo, branch, filename) {
  const rawHeaders = {
    'Accept': '*/*',
    ...(TOKEN ? { 'Authorization': `token ${TOKEN}` } : {})
  };

  const fallbacks = [
    // raw directo
    `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/formatted/${filename}`,
    // ruta /blob con ?raw=1 (a veces evita bloqueos)
    `https://github.com/${owner}/${repo}/blob/${branch}/formatted/${filename}?raw=1`,
    // mirror alternativo
    `https://raw.fastgit.org/${owner}/${repo}/${branch}/formatted/${filename}`
  ];

  for (const url of fallbacks) {
    const r = await httpGet(`${url}?_=${Date.now()}`, rawHeaders);
    if (r.ok) return r.body;
  }
  throw new Error('No pude descargar recipes.json de ninguna URL fallback.');
}

async function main() {
  console.log('> Descubriendo recipes*.json en /formatted (Contents API)…');
  ensureDir(OUT_DIR);

  const meta = await findRecipesMetaViaContentsAPI();
  if (!meta) {
    throw new Error('No encontré ningún "recipes*.json" dentro de /formatted en los repos candidatos.');
  }
  console.log(`  - Encontrado: ${meta.owner}/${meta.repo}@${meta.branch} ➜ formatted/${meta.name}`);

  // 1) Intentar vía API / download_url
  let txt = null;
  try {
    txt = await fetchTextFromApiOrDownload(meta);
    console.log('  - Obtenido vía API/download_url.');
  } catch (e) {
    console.warn(`  ! API/download_url falló: ${e.message}`);
  }

  // 2) Si no se pudo, intentar fallbacks directos
  if (!txt) {
    console.log('  - Probando fallbacks directos…');
    txt = await fetchWithFallbacks(meta.owner, meta.repo, meta.branch, meta.name);
    console.log('  - Obtenido vía fallback.');
  }

  // Validar que sea JSON del dump (array grande)
  let recipes;
  try {
    recipes = JSON.parse(txt);
    if (!Array.isArray(recipes)) {
      throw new Error('El archivo no es un JSON de array.');
    }
  } catch (e) {
    throw new Error('recipes.json no es JSON válido: ' + e.message);
  }

  // Guardar completo
  fs.writeFileSync(OUT_JSON, JSON.stringify(recipes, null, 2), 'utf8');
  console.log(`  - Guardado: ${OUT_JSON} (${recipes.length} objetos)`);

  // Plano JSON
  const flat = toFlatRows(recipes);
  fs.writeFileSync(OUT_FLAT_JSON, JSON.stringify(flat, null, 2), 'utf8');
  console.log(`  - Guardado: ${OUT_FLAT_JSON} (${flat.length} filas)`);

  // CSV
  const headersCsv = ['OUTPUT_ID','OUTPUT_QTY','INPUT_ID','INPUT_QTY','STATION','FOCUS_BASED'];
  const lines = [headersCsv.join(',')];
  for (const r of flat) {
    const row = headersCsv.map(h => {
      const s = (r[h] == null ? '' : String(r[h]));
      return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
    });
    lines.push(row.join(','));
  }
  fs.writeFileSync(OUT_FLAT_CSV, lines.join('\n'), 'utf8');
  console.log(`  - Guardado: ${OUT_FLAT_CSV}`);

  console.log('> Done.');
}

main().catch(err => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
