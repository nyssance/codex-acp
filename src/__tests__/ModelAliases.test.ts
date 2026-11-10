import {mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {expect, it} from "vitest";
import {ModelAliases} from "../alwith/codex/modelAliases";

it("retains full native and provider capabilities under persisted model aliases", () => {
    const root = mkdtempSync(join(tmpdir(), "model-alias-test-"));
    const aliases = new ModelAliases();
    try {
        const base = join(root, "native.json");
        const provider = join(root, "provider.json");
        const native = {
            slug: "gpt-test",
            context_window: 200000,
            supports_image_detail_original: true,
        };
        const flash = {
            slug: "flash",
            context_window: 1000000,
            supported_reasoning_levels: [{effort: "high"}],
            supports_image_detail_original: false,
        };
        writeFileSync(base, JSON.stringify({models: [native]}));
        writeFileSync(provider, JSON.stringify({models: [flash]}));
        const entries = [{id: "gateway:one:flash", upstream: "flash", catalog: provider}];
        const path = aliases.catalog(base, entries)!;
        expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
            models: [
                native,
                {...native, slug: "native:gpt-test"},
                {
                    ...flash,
                    slug: "gateway:one:flash",
                    auto_review_model_override: "gateway:one:flash",
                },
            ],
        });
        expect(aliases.catalog(base, entries)).toBe(path);
        expect(JSON.parse(readFileSync(provider, "utf8"))).toEqual({
            models: [flash],
        });
        writeFileSync(provider, JSON.stringify({models: [{...flash, context_window: 256000}]}));
        const changed = aliases.catalog(base, entries)!;
        expect(changed).not.toBe(path);
        expect(JSON.parse(readFileSync(path, "utf8")).models[2].context_window).toBe(1000000);
        expect(JSON.parse(readFileSync(changed, "utf8")).models[2].context_window).toBe(256000);
        aliases.close();
        expect(existsSync(path)).toBe(false);
        expect(existsSync(changed)).toBe(false);
    } finally {
        aliases.close();
        rmSync(root, {recursive: true, force: true});
    }
});

it("retains native alias metadata without remaining gateway definitions", () => {
    const root = mkdtempSync(join(tmpdir(), "native-alias-test-"));
    const aliases = new ModelAliases();
    try {
        const base = join(root, "native.json");
        writeFileSync(
            base,
            JSON.stringify({
                models: [{slug: "gpt-test", context_window: 200000}],
            }),
        );
        const path = aliases.catalog(base, []);
        expect(path).toBeDefined();
        expect(JSON.parse(readFileSync(path!, "utf8")).models).toContainEqual({
            slug: "native:gpt-test",
            context_window: 200000,
        });
    } finally {
        aliases.close();
        rmSync(root, {recursive: true, force: true});
    }
});

it.each([undefined, null])("reviews a gateway model with itself when its catalog names no reviewer (%s)", reviewer => {
    const root = mkdtempSync(join(tmpdir(), "gateway-review-model-test-"));
    const aliases = new ModelAliases();
    try {
        const base = join(root, "catalog.json");
        const native = {
            slug: "native-model",
            auto_review_model_override: null,
        };
        const provider = {
            slug: "provider-model",
            auto_review_model_override: reviewer,
        };
        writeFileSync(base, JSON.stringify({models: [native, provider]}));
        const first = "gateway:first:provider-model";
        const second = "gateway:second:provider-model";
        const path = aliases.catalog(base, [
            {id: first, upstream: "provider-model"},
            {id: second, upstream: "provider-model"},
        ]);
        const catalog = JSON.parse(readFileSync(path, "utf8"));
        for (const id of [first, second])
            expect(catalog.models.find((model: {slug: string}) => model.slug === id)).toMatchObject({auto_review_model_override: id});
        expect(catalog.models.find((model: {slug: string}) => model.slug === "native:native-model")).toEqual({
            ...native,
            slug: "native:native-model",
        });
        expect(JSON.parse(readFileSync(base, "utf8"))).toEqual({
            models: [native, JSON.parse(JSON.stringify(provider))],
        });
    } finally {
        aliases.close();
        rmSync(root, {recursive: true, force: true});
    }
});

it("resolves a catalog's reviewer to the same gateway's model", () => {
    const root = mkdtempSync(join(tmpdir(), "gateway-reviewer-test-"));
    const aliases = new ModelAliases();
    try {
        const base = join(root, "catalog.json");
        const reasoner = {
            slug: "reasoner",
            auto_review_model_override: "flash",
        };
        const flash = {slug: "flash", auto_review_model_override: null};
        writeFileSync(base, JSON.stringify({models: [reasoner, flash]}));
        const path = aliases.catalog(base, [
            {id: "gateway:first:reasoner", upstream: "reasoner"},
            {id: "gateway:first:flash", upstream: "flash"},
            {id: "gateway:second:reasoner", upstream: "reasoner"},
            {id: "gateway:second:flash", upstream: "flash"},
        ]);
        const catalog = JSON.parse(readFileSync(path, "utf8"));
        const overrides = Object.fromEntries(
            catalog.models
                .filter((model: {slug: string}) => model.slug.startsWith("gateway:"))
                .map((model: Record<string, unknown>) => [model["slug"], model["auto_review_model_override"]]),
        );
        expect(overrides).toEqual({
            "gateway:first:reasoner": "gateway:first:flash",
            "gateway:first:flash": "gateway:first:flash",
            "gateway:second:reasoner": "gateway:second:flash",
            "gateway:second:flash": "gateway:second:flash",
        });
        expect(() => aliases.catalog(base, [{id: "gateway:third:reasoner", upstream: "reasoner"}])).toThrow(
            'Gateway model "reasoner" reviews with "flash", which the gateway does not list',
        );
    } finally {
        aliases.close();
        rmSync(root, {recursive: true, force: true});
    }
});
