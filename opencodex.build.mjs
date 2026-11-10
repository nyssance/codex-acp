// Builds src/alwith/codex/generated/opencodex.js; `opencodex.d.ts` beside it is the typed surface.
const result = await Bun.build({
    entrypoints: ['opencodex.entry.mjs'],
    target: 'bun',
    format: 'esm',
    outdir: 'src/alwith/codex/generated',
    naming: 'opencodex.js',
});
if (!result.success) throw new AggregateError(result.logs, 'Build failed: opencodex.entry.mjs');
