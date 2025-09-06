// scripts/fetch_recipes.js
// Node 18+. Encuentra y descarga recipes*.json (API Contents o Git Trees), decodifica y genera plano/CSV.

const https = require('https');
const fs = require('fs');
const path = require('path');

const OUT_DIR       = path.join(process.cwd(), 'data');
const OUT_JSON      = path.join(OUT_DIR, 'recipes.json');
const OUT_FLAT_JSON = path.join(OUT_DIR, 'recipes.flat.json');
const OUT_FLAT_CSV  = path.join(OUT_DIR, 'recipes.flat.csv');

// Candidatos (añadí tu repo como 3º por si ya tienes formatted/recipes.json)
const CANDIDATE_REPOS = [
  { owner: 'ao-data',        repo: 'ao-bin-dumps',  branch: 'master' },
  { owner: 'broderickhyman', repo: 'ao-bin-dumps',  branch: 'master' },
  { owner: 'GjhanAi',        repo: 'albion-recipes', branch: 'main', preferPath: 'formatted/recipes.json' },
];

const TOKEN = process.env.GITHUB_TOKEN || '';

function httpGet(url, headers = {}) {
  const h = { 'User-Agent': 'AlbionCalc-RecipesSync/1.0', ...headers };
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: h }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          code: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          url
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function ensureDir(p){ if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function maybeDecodeGithubContent(body){
  try {
    const o = JSON.parse(body);
    if (o && o.content && /base64/i.test(o.encoding || '')) {
      return Buffer.from(o.content, 'base64').toString('utf8');
    }
  } catch(_) {}
  return body;
}

function g(obj, keys, def = '') {
  for (const k of keys) if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) return obj[k];
  return def;
}

function toFlatRows(recipes){
  const out = [];
  for (const r of recipes){
    const outId   = g(r, ['OutputObject','OutputItem','OutputItemId','output','UniqueName','ItemId'], '');
    const outQty  = Number(g(r, ['OutputAmount','OutputQuantity','OutputQty','amount','quantity','NumProduced','OutputCount'], 1)) || 1;
    const station = g(r, ['CraftingCategory','Station','station','building','CraftingStation'], '') || 'recipes.json';
    const focus   = !!g(r, ['FocusBased','Focus','focusBased','focus'], false);
    const inputs  = g(r, ['Ingredients','ingredients','EntryRequirements','craftingRequirements','Materials','crafting','CraftingRequirements'], []);

    if (!outId) continue;
    if (Array.isArray(inputs) && inputs.length){
      for (const ing of inputs){
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

// --- 1) Intento rápido: si dieron preferPath, pruébalo directo
async function tryPreferredPath({owner, repo, branch, preferPath}){
  if (!preferPath) return null;
  const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${preferPath}`;
  const r = await httpGet(`${raw}?_=${Date.now()}`, authRaw());
  if (r.ok) return { owner, repo, branch, path: preferPath, source: 'preferred-raw' };
  return null;
}

// --- 2) Contents API: lista /formatted y busca recipes*.json
async function findViaContents(owner, repo, branch){
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/formatted?ref=${branch}`;
  const r = await httpGet(url, authJson());
  if (!r.ok) return null;
  try {
    const list = JSON.parse(r.body);
    if (Array.isArray(list)) {
      const hit = list.find(e => e && e.type === 'file' && /^recipes.*\.json$/i.test(String(e.name || '')));
      if (hit) {
        return {
          owner, repo, branch, path: `formatted/${hit.name}`,
          download_url: hit.download_url || null,
          api_url: hit.url || null,
          source: 'contents'
        };
      }
    }
  } catch(_){}
  return null;
}

// --- 3) Git Trees API (recorre todo el repo)
async function findViaGitTree(owner, repo, branch){
  const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
  const r = await httpGet(url, authJson());
  if (!r.ok) return null;
  try {
    const tree = JSON.parse(r.body).tree || [];
    // Preferimos los que estén en /formatted/
    const all = tree.filter(e => e.type === 'blob' && /(^|\/)recipes[^/]*\.json$/i.test(e.path));
    if (!all.length) return null;
    const preferred = all.find(e => /(^|\/)formatted\//i.test(e.path)) || all[0];
    return { owner, repo, branch, path: preferred.path, source: 'git-tree' };
  } catch(_){}
  return null;
}

function authJson(){
  return { 'Accept': 'application/vnd.github+json', ...(TOKEN ? { 'Authorization': `token ${TOKEN}` } : {}) };
}
function authRaw(){
  return { 'Accept': '*/*', ...(TOKEN ? { 'Authorization': `token ${TOKEN}` } : {}) };
}

async function downloadFileMeta(meta){
  // 1) Si vino de Contents con download_url, úsalo
  if (meta.download_url){
    const r = await httpGet(`${meta.download_url}?_=${Date.now()}`, authRaw());
    if (r.ok) return r.body;
  }
  // 2) Si vino con api_url (contents single file), decodifica
  if (meta.api_url){
    const r = await httpGet(`${meta.api_url}?ref=${meta.branch}&_=${Date.now()}`, authJson());
    if (r.ok) return maybeDecodeGithubContent(r.body);
  }
  // 3) Raw directo por path
  const raws = [
    `https://raw.githubusercontent.com/${meta.owner}/${meta.repo}/${meta.branch}/${meta.path}`,
    `https://github.com/${meta.owner}/${meta.repo}/raw/${meta.branch}/${meta.path}`,
    `https://raw.fastgit.org/${meta.owner}/${meta.repo}/${meta.branch}/${meta.path}`,
  ];
  for (const u of raws){
    const r = await httpGet(`${u}?_=${Date.now()}`, authRaw());
    if (r.ok) return r.body;
  }
  throw new Error('No pude descargar el archivo (API ni raw).');
}

async function discoverRecipesFile(){
  for (const cand of CANDIDATE_REPOS){
    // a) intento preferido (tu propio repo con path fijo)
    const pref = await tryPreferredPath(cand);
    if (pref) return pref;

    // b) contents en /formatted
    const byContents = await findViaContents(cand.owner, cand.repo, cand.branch);
    if (byContents) return byContents;

    // c) git tree (recursivo)
    const byTree = await findViaGitTree(cand.owner, cand.repo, cand.branch);
    if (byTree) return byTree;
  }
  return null;
}

async function main(){
  console.log('> Buscando recipes*.json (Contents API / Git Trees)…');
  ensureDir(OUT_DIR);

  const meta = await discoverRecipesFile();
  if (!meta) throw new Error('No encontré ningún "recipes*.json" en los repos candidatos.');

  console.log(`  - Fuente: ${meta.owner}/${meta.repo}@${meta.branch} → ${meta.path} (${meta.source})`);

  const txt = await downloadFileMeta(meta);

  let recipes;
  try {
    recipes = JSON.parse(txt);
    if (!Array.isArray(recipes)) throw new Error('El archivo no es un JSON de array.');
  } catch(e){ throw new Error('recipes.json no es JSON válido: '+e.message); }

  fs.writeFileSync(OUT_JSON, JSON.stringify(recipes, null, 2), 'utf8');
  console.log(`  - Guardado: ${OUT_JSON} (${recipes.length} objetos)`);

  const flat = toFlatRows(recipes);
  fs.writeFileSync(OUT_FLAT_JSON, JSON.stringify(flat, null, 2), 'utf8');
  console.log(`  - Guardado: ${OUT_FLAT_JSON} (${flat.length} filas)`);

  const headersCsv = ['OUTPUT_ID','OUTPUT_QTY','INPUT_ID','INPUT_QTY','STATION','FOCUS_BASED'];
  const lines = [headersCsv.join(',')];
  for (const r of flat){
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

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
