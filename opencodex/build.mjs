// Builds src/alwith/codex/generated/opencodex.js; `opencodex.d.ts` beside it is the typed surface.
// opencodex is installed here, apart from the adapter: it depends on the `bun` package, whose
// `node_modules/.bin/bun` would otherwise run every script of the adapter instead of the installed Bun.
import {join} from 'node:path';

const directory = import.meta.dir;
const result = await Bun.build({
    entrypoints: [join(directory, 'entry.mjs')],
    target: 'bun',
    format: 'esm',
    outdir: join(directory, '../src/alwith/codex/generated'),
    naming: 'opencodex.js',
});
if (!result.success) throw new AggregateError(result.logs, 'Build failed: opencodex/entry.mjs');
