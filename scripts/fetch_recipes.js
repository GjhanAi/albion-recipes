// scripts/fetch_recipes.js
// Node 18+. Descarga recipes.json desde ao-data (GitHub), con fallback y genera formatos plano/CSV.
const https = require('https');
const fs = require('fs');
const path = require('path');

// ==== Salidas ====
const OUT_DIR       = path.join(process.cwd(), 'data');
const OUT_JSON      = path.join(OUT_DIR, 'recipes.json');
const OUT_FLAT_JSON = path.join(OUT_DIR, 'recipes.flat.json');
const OUT_FLAT_CSV  = path.join(OUT_DIR, 'recipes.flat.csv');

// ==== Fuentes (prioridad: API -> RAW GitHub -> RAW GitHub (alt) -> CDN) ====
const SRC_URL_API = 'https://api.github.com/repos/ao-data/ao-bin-dumps/contents/formatted/recipes.json?ref=master';
const SRC_URL_FALLBACKS = [
  'https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/formatted/recipes.json',
  'https://github.com/ao-data/ao-bin-dumps/raw/master/formatted/recipes.json',
  'https://cdn.jsdelivr.net/gh/ao-data/ao-bin-dumps@master/formatted/recipes.json'
];

// Token opcional (sube el cupo y evita 403 intermitentes)
const TOKEN = process.env.GITHUB_TOKEN || '';

// ==================== HTTP helpers ====================
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ code: res.statusCode, body, headers: res.headers });
        } else {
          const msg = `HTTP ${res.statusCode} on ${url}: ${body.slice(0, 200)}...`;
          reject(new Error(msg));
        }
      });
    });
    req.on('error', reject);
    // (opcional) timeout básico
    req.setTimeout(15000, () => { req.destroy(new Error('Timeout')); });
    req.end();
  });
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function cacheBust(url) {
  return url + (url.includes('?') ? '&' : '?') + '_=' + Date.now();
}

// Si viene de la API contents de GitHub, decodifica base64 a texto plano
function maybeDecodeGithubContent(body) {
  try {
    const o = JSON.parse(body);
    if (o && o.content && (o.encoding === 'base64' || o.encoding === 'Base64')) {
      return Buffer.from(o.content, 'base64').toString('utf8');
    }
  } catch (_) { /* no era JSON de la API */ }
  return body;
}

// ==================== Normalización de recetas a "flat rows" ====================
function g(obj, keys, def = '') {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) {
      return obj[k];
    }
  }
  return def;
}

function toFlatRows(recipes) {
  const out = [];
  for (const r of recipes) {
    const outId   = g(r, ['OutputObject','OutputItem','OutputItemId','output','UniqueName','ItemId'], '');
    const outQty  = Number(g(r, ['OutputAmount','OutputQuantity','OutputQty','amount','quantity','NumProduced','OutputCount'], 1)) || 1;
    const station = g(r, ['CraftingCategory','Station','station','building','CraftingStation'], '');
    const focus   = !!g(r, ['FocusBased','Focus','focusBased','focus'], false);
    const inputs  = g(r, ['Ingredients','ingredients','EntryRequirements','craftingRequirements','Materials','crafting','CraftingRequirements'], []);

    if (!outId) continue;

    if (Array.isArray(inputs) && inputs.length) {
      for (const ing of inputs) {
        const inId  = g(ing, ['Object','Item','ItemId','item','UniqueName','id'], '');
        const inQty = Number(g(ing, ['Count','Amount','amount','count','qty','Quantity'], 1)) || 1;
        if (inId) out.push({
          OUTPUT_ID: outId,
          OUTPUT_QTY: outQty,
          INPUT_ID: inId,
          INPUT_QTY: inQty,
          STATION: station || 'recipes.json',
          FOCUS_BASED: focus ? 1 : 0
        });
      }
    } else {
      // sin ingredientes explícitos: deja rastro mínimo
      out.push({
        OUTPUT_ID: outId,
        OUTPUT_QTY: outQty,
        INPUT_ID: '',
        INPUT_QTY: 0,
        STATION: station || 'recipes.json',
        FOCUS_BASED: focus ? 1 : 0
      });
    }
  }
  return out;
}

// ==================== Flujo principal ====================
async function fetchRecipesText() {
  const baseHeaders = {
    'User-Agent': 'AlbionCalc-RecipesSync/1.0',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
  };

  // 1) Intento por API (contents → base64 o download_url)
  const apiHeaders = { ...baseHeaders, 'Accept': 'application/vnd.github+json' };
  if (TOKEN) apiHeaders['Authorization'] = `token ${TOKEN}`;

  try {
    const { body } = await httpGet(cacheBust(SRC_URL_API), apiHeaders);
    const txt = maybeDecodeGithubContent(body);
    // validar que sea JSON real antes de devolver
    JSON.parse(txt);
    console.log(`  ✔ Fuente: API (${SRC_URL_API})`);
    return txt;
  } catch (e) {
    console.warn('  ⚠ API falló:', e.message);
  }

  // 2) Fallbacks RAW/CDN
  for (const url of SRC_URL_FALLBACKS) {
    const h = { ...baseHeaders, 'Accept': '*/*' };
    if (TOKEN && (url.includes('github.com') || url.includes('githubusercontent.com'))) {
      h['Authorization'] = `token ${TOKEN}`;
    }
    try {
      const { body } = await httpGet(cacheBust(url), h);
      JSON.parse(body); // validar
      console.log(`  ✔ Fuente: RAW/CDN (${url})`);
      return body;
    } catch (e) {
      console.warn(`  ⚠ Fallback falló (${url}):`, e.message);
    }
  }

  throw new Error('No pude descargar recipes.json de ninguna fuente (API ni fallbacks).');
}

async function main() {
  console.log('> Syncing recipes from ao-data...');
  ensureDir(OUT_DIR);

  const recipesText = await fetchRecipesText();

  // Guardar recipes.json (completo)
  let recipes;
  try {
    recipes = JSON.parse(recipesText);
  } catch (e) {
    throw new Error('recipes.json no es JSON válido: ' + e.message);
  }
  fs.writeFileSync(OUT_JSON, JSON.stringify(recipes, null, 2), 'utf8');
  console.log(`  - Guardado: ${OUT_JSON} (${recipes.length} objetos)`);

  // Plano (flat)
  const flat = toFlatRows(recipes);
  fs.writeFileSync(OUT_FLAT_JSON, JSON.stringify(flat, null, 2), 'utf8');
  console.log(`  - Guardado: ${OUT_FLAT_JSON} (${flat.length} filas)`);

  // CSV
  const headersCsv = ['OUTPUT_ID','OUTPUT_QTY','INPUT_ID','INPUT_QTY','STATION','FOCUS_BASED'];
  const lines = [headersCsv.join(',')];
  for (const r of flat) {
    const row = headersCsv.map(h => {
      const val = r[h];
      const s = (val == null ? '' : String(val));
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
