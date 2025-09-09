// scripts/fetch_recipes.js
// Descarga el recipes.json grande desde ao-bin-dumps (RAW) y construye recipes.flat.json compacto.

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const CANDIDATES = [
  'https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/formatted/recipes.json',
  'https://github.com/ao-data/ao-bin-dumps/raw/master/formatted/recipes.json',
];

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const opts = { headers: { 'User-Agent': 'AlbionRecipesSync/1.0' } };

    const req = https.get(url, opts, (res) => {
      // Sigue redirecciones
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close(); try { fs.unlinkSync(dest); } catch (_) {}
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    });

    req.on('error', (err) => {
      try { file.close(); fs.unlinkSync(dest); } catch (_) {}
      reject(err);
    });
  });
}

(async () => {
  fs.mkdirSync('data', { recursive: true });
  const outJson = path.join('data', 'recipes.json');

  let ok = false, lastErr = null;
  for (const url of CANDIDATES) {
    try {
      console.log('Descargando:', url);
      await download(url, outJson);
      const size = fs.statSync(outJson).size;
      if (size < 2_000_000) throw new Error(`archivo demasiado pequeño (${size} bytes)`);
      console.log('OK:', url, 'bytes =', size);
      ok = true;
      break;
    } catch (e) {
      console.error('Fallo:', url, e.message);
      lastErr = e;
    }
  }
  if (!ok) throw lastErr || new Error('No se pudo descargar recipes.json');

  // Construir versión plana
  try {
    console.log('Construyendo recipes.flat.json …');
    const raw = JSON.parse(fs.readFileSync(outJson, 'utf8'));
    const flat = [];

    for (const r of raw) {
      const outId  = r.OutputObject || r.OutputItem || r.OutputItemId || r.output || '';
      const outQty = r.OutputAmount || r.OutputQuantity || r.OutputQty || r.quantity || 1;
      const cat    = r.CraftingCategory || r.Station || r.station || 'unknown';
      const ings   = r.Ingredients || r.ingredients || r.EntryRequirements || [];

      if (!outId || !Array.isArray(ings) || !ings.length) continue;

      flat.push({
        OutputItemId: outId,
        OutputAmount: outQty,
        CraftingCategory: cat,
        Ingredients: ings.map(ing => ({
          ItemId:  ing.Object || ing.Item || ing.ItemId || ing.item || '',
          Amount:  ing.Count  || ing.Amount || ing.count  || ing.amount || 1,
        })).filter(x => x.ItemId),
      });
    }

    fs.writeFileSync(path.join('data', 'recipes.flat.json'), JSON.stringify(flat));
    console.log('recipes.flat.json filas =', flat.length);
  } catch (e) {
    console.error('Error creando flat:', e.message);
  }
})();
