for (const options of [
    {
        entrypoints: ["src/index.ts"],
        target: "bun",
        naming: "index.js",
        external: ["@openai/codex"],
    },
    {
        entrypoints: ["src/CodexCapabilitiesClient.ts"],
        target: "browser",
        naming: "client.js",
    },
]) {
    const result = await Bun.build({
        ...options,
        outdir: "dist",
        format: "esm",
    });
    if (!result.success)
        throw new AggregateError(
            result.logs,
            `Build failed: ${options.entrypoints[0]}`,
        );
}
