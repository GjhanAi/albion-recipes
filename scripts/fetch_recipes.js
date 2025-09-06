// scripts/fetch_recipes.js
// Node 18+. Descarga recipes.json desde ao-data (API GitHub), lo decodifica y genera formatos plano/CSV.
const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(process.cwd(), 'data');
const OUT_JSON = path.join(OUT_DIR, 'recipes.json');
const OUT_FLAT_JSON = path.join(OUT_DIR, 'recipes.flat.json');
const OUT_FLAT_CSV = path.join(OUT_DIR, 'recipes.flat.csv');

const SRC_URL = 'https://api.github.com/repos/ao-data/ao-bin-dumps/contents/formatted/recipes.json?ref=master';
const TOKEN = process.env.GITHUB_TOKEN || '';

function httpGet(url, headers = {}){
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      let chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ code: res.statusCode, body, headers: res.headers });
        } else {
          reject(new Error(`HTTP ${res.statusCode} on ${url}: ${body.slice(0,200)}...`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function ensureDir(p){
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function maybeDecodeGithubContent(body){
  // Si viene de Contents API de GitHub, es JSON con {content: base64, encoding: "base64"}
  try {
    const o = JSON.parse(body);
    if (o && o.content && (o.encoding === 'base64' || o.encoding === 'Base64')) {
      return Buffer.from(o.content, 'base64').toString('utf8');
    }
  } catch(_) {}
  return body;
}

// --- Helpers de normalización
function g(obj, keys, def=''){
  for (const k of keys){
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) {
      return obj[k];
    }
  }
  return def;
}

function toFlatRows(recipes){
  const out = [];
  for (const r of recipes){
    const outId   = g(r, ['OutputObject','OutputItem','OutputItemId','output','UniqueName','ItemId'], '');
    const outQty  = Number(g(r, ['OutputAmount','OutputQuantity','OutputQty','amount','quantity','NumProduced','OutputCount'], 1)) || 1;
    const station = g(r, ['CraftingCategory','Station','station','building','CraftingStation'], '');
    const focus   = !!g(r, ['FocusBased','Focus','focusBased','focus'], false);
    const inputs  = g(r, ['Ingredients','ingredients','EntryRequirements','craftingRequirements','Materials','crafting','CraftingRequirements'], []);

    if (!outId) continue;
    if (Array.isArray(inputs) && inputs.length){
      for (const ing of inputs){
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
      // sin ingredientes explícitos: dejamos rastro mínimo
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

async function main(){
  console.log('> Syncing recipes from ao-data (GitHub API)...');
  ensureDir(OUT_DIR);

  const headers = {
    'User-Agent': 'AlbionCalc-RecipesSync/1.0',
    'Accept': 'application/vnd.github+json',
    'Cache-Control': 'no-cache'
  };
  if (TOKEN) headers['Authorization'] = `token ${TOKEN}`;

  const { body } = await httpGet(SRC_URL, headers);
  const recipesText = maybeDecodeGithubContent(body);

  // Guardar recipes.json (completo)
  let recipes;
  try {
    recipes = JSON.parse(recipesText);
  } catch (e){
    throw new Error('recipes.json no es JSON válido: ' + e.message);
  }
  fs.writeFileSync(OUT_JSON, JSON.stringify(recipes, null, 2), 'utf8');
  console.log(`  - Guardado: ${OUT_JSON} (${recipes.length} objetos)`);

  // Plano
  const flat = toFlatRows(recipes);
  fs.writeFileSync(OUT_FLAT_JSON, JSON.stringify(flat, null, 2), 'utf8');
  console.log(`  - Guardado: ${OUT_FLAT_JSON} (${flat.length} filas)`);

  // CSV
  const headersCsv = ['OUTPUT_ID','OUTPUT_QTY','INPUT_ID','INPUT_QTY','STATION','FOCUS_BASED'];
  const lines = [headersCsv.join(',')];
  for (const r of flat){
    const row = headersCsv.map(h => {
      const val = r[h];
      const s = (val==null ? '' : String(val));
      // escapado CSV básico
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
