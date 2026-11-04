// Copia las reglas de categorías del plugin (names, categoryRules, categoryTable) a lib/. Uso: node scripts/sync-lib.mjs <carpeta del plugin>
import { copyFileSync } from "node:fs";
import { join } from "node:path";
const plugin = process.argv[2];
if (!plugin) { console.error("uso: node scripts/sync-lib.mjs <carpeta del plugin>"); process.exit(1); }
for (const f of ["names.js", "categoryRules.js", "categoryTable.js"]) copyFileSync(join(plugin, "src", f), join("lib", f));
console.log("lib/ actualizado desde", plugin);
