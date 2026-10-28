for (const options of [
    {
        entrypoints: ["src/import/index.ts"],
        target: "browser",
        naming: "import.js",
    },
    {
        entrypoints: ["src/index.ts"],
        target: "bun",
        naming: "index.js",
        external: ["@openai/codex"],
    },
    {
        entrypoints: ["src/client/index.ts"],
        target: "browser",
        naming: "client.js",
        external: [
            "@alwith/api",
            "@alwith/api/*",
            "@agentclientprotocol/sdk",
            "@agentclientprotocol/sdk/*",
        ],
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
