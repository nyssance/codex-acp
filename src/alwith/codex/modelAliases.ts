import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledModels } from "./bundledModels";
import { isRecord } from "../permissions/json";

export type ModelAlias = { id: string; upstream: string; catalog?: string };

/** Temporary model metadata only; the selected route is persisted by Codex in its model field. */
export class ModelAliases {
    private directory: string | undefined;
    private readonly paths = new Map<string, string>();

    catalog(base: string | undefined, aliases: ModelAlias[]): string {
        const files = new Map<string, Record<string, unknown>[]>();
        const read = (path: string): Record<string, unknown>[] => {
            const previous = files.get(path);
            if (previous) return previous;
            const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
            if (
                !isRecord(parsed) ||
                !Array.isArray(parsed["models"]) ||
                !parsed["models"].every(isRecord)
            )
                throw new Error("Invalid Codex model catalog");
            files.set(path, parsed["models"]);
            return parsed["models"];
        };
        const models = [...(base === undefined ? bundledModels() : read(base))];
        for (const entry of [...models]) {
            if (typeof entry["slug"] === "string")
                models.push({
                    ...entry,
                    slug: `native:${encodeURIComponent(entry["slug"])}`,
                });
        }
        for (const alias of aliases) {
            // As at registration: the gateway's catalog file describes the model, or Codex does.
            const candidates = alias.catalog ? read(alias.catalog) : models;
            const entry =
                candidates.find((model) => model["slug"] === alias.upstream) ??
                models.find((model) => model["slug"] === alias.upstream);
            if (entry === undefined)
                throw new Error(
                    `Gateway model "${alias.upstream}" is in no model catalog`,
                );
            models.push({ ...entry, slug: alias.id });
        }
        const body = JSON.stringify({ models });
        const digest = createHash("sha256").update(body).digest("hex");
        const previous = this.paths.get(digest);
        if (previous) return previous;
        this.directory ??= mkdtempSync(
            join(tmpdir(), "codex-acp-model-aliases-"),
        );
        const path = join(this.directory, `${digest}.json`);
        writeFileSync(path, body, { mode: 0o600 });
        this.paths.set(digest, path);
        return path;
    }

    close(): void {
        if (this.directory !== undefined)
            rmSync(this.directory, { recursive: true, force: true });
        this.paths.clear();
        this.directory = undefined;
    }
}
