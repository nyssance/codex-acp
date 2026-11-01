import { createRequire } from "node:module";
import crossSpawn from "cross-spawn";
import { isRecord } from "../permissions/json";

let cached: Record<string, unknown>[] | undefined;

/** Read metadata without model discovery, authentication or an agent session. */
export function bundledModels(): Record<string, unknown>[] {
    if (cached !== undefined) return cached;
    const configured = process.env["CODEX_PATH"];
    const command = configured ?? process.execPath;
    const args = [
        ...(configured
            ? []
            : [
                  createRequire(import.meta.url).resolve(
                      "@openai/codex/bin/codex.js",
                  ),
              ]),
        "debug",
        "models",
        "--bundled",
    ];
    const result = crossSpawn.sync(command, args, {
        encoding: "utf8",
        timeout: 10_000,
    });
    if (result.error || result.status !== 0)
        throw new Error("Could not read bundled Codex model metadata", {
            cause: result.error,
        });
    const value: unknown = JSON.parse(result.stdout);
    if (
        !isRecord(value) ||
        !Array.isArray(value["models"]) ||
        !value["models"].every(isRecord)
    )
        throw new Error("Invalid bundled Codex model metadata");
    cached = value["models"];
    return cached;
}
