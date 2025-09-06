# Albion Recipes Pack

Este repo contiene un flujo para **descargar, versionar y publicar** los archivos de recetas de *Albion Online*:

- `data/recipes.json` → archivo **completo** (tal como viene del repositorio `ao-data/ao-bin-dumps`).
- `data/recipes.flat.json` → **formato plano** (1 fila por ingrediente), fácil de consumir desde Google Apps Script.
- `data/recipes.flat.csv` → el mismo plano en CSV.

El flujo funciona con una **GitHub Action** que corre cada 12 horas o de forma manual (Actions → *Run workflow*).
No necesitas dependencias: solo Node 18+.

## Uso rápido

1. Crea un repo vacío (p.ej. `tuusuario/albion-recipes`) y sube estos archivos tal cual.
2. Ve a **Actions** en GitHub y ejecuta **Sync Albion Recipes** (Run workflow).
3. Tras el primer run, revisa la carpeta `data/`:
   - `recipes.json`
   - `recipes.flat.json`
   - `recipes.flat.csv`

## Conectar con AlbionCalc

En tu Apps Script, usa tu `raw` como primera fuente:

```js
const RECIPES_URLS = [
  "https://raw.githubusercontent.com/TU_USUARIO/TU_REPO/refs/heads/main/data/recipes.json",
  "https://raw.githubusercontent.com/ao-data/ao-bin-dumps/master/formatted/recipes.json"
];
```

Luego corre tu función `cargarRecetas_v2()` (o la que parsee el JSON a tu hoja `RECETAS`).

## ¿Por qué así?

- Google Apps Script a veces recibe **HTTP 403** desde `raw.githubusercontent.com` por restricciones de red.
- Este flujo **usa la API de GitHub**, decodifica el contenido Base64 y **publica** el artefacto en **tu repo**, desde donde sí podrás leer el `raw` sin bloqueos.

## Seguridad

El workflow usa el `GITHUB_TOKEN` del propio repo (permiso `contents: write`) **solo para commitear** los archivos generados.
No guardes tokens personales en el repo.
