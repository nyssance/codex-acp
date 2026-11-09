import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledModels } from "./bundledModels";
import { isRecord } from "../../permissions/json";

export type ModelAlias = { id: string; upstream: string; catalog?: string };

/**
 * Codex reviews approvals with the model named here, or its native reviewer, which this
 * gateway may not serve. A catalog's reviewer is a model of the same gateway; without one the
 * selected model reviews itself, as Codex does when its reviewer is in no catalog.
 */
function reviewer(
    alias: ModelAlias,
    entry: Record<string, unknown>,
    aliases: ModelAlias[],
): string {
    const upstream = entry["auto_review_model_override"];
    if (upstream === undefined || upstream === null) return alias.id;
    if (typeof upstream !== "string")
        throw new Error("Invalid Codex model catalog");
    const gateway = alias.id.slice(0, alias.id.lastIndexOf(":") + 1);
    const sibling = aliases.find(
        (candidate) =>
            candidate.id.startsWith(gateway) &&
            candidate.upstream === upstream,
    );
    if (sibling === undefined)
        throw new Error(
            `Gateway model "${alias.upstream}" reviews with "${upstream}", which the gateway does not list`,
        );
    return sibling.id;
}

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
            models.push({
                ...entry,
                slug: alias.id,
                auto_review_model_override: reviewer(alias, entry, aliases),
            });
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
