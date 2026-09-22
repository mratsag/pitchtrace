import fs from 'node:fs/promises';
import { findingCodesDocPath } from './docs-path.js';
import { renderFindingCodesDoc } from './docs.js';

const target = findingCodesDocPath();
await fs.writeFile(target, renderFindingCodesDoc(), 'utf8');
console.log(JSON.stringify({ level: 'info', msg: 'finding codes doc written', target }));
