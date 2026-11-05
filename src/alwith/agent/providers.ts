import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";

import type { InputModality } from "../../app-server/InputModality";
import type { Model, ReasoningEffortOption } from "../../app-server/v2";
import type { JsonObject } from "../../CodexAcpClient";
import { isRecord } from "../../permissions/json";

/** The one provider slot Codex exposes: where its OpenAI-protocol traffic goes. */
export const OPENAI_PROVIDER_ID = "openai";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
/** Select group of the models Codex serves through the ChatGPT sign-in: named after the models, not the CLI. */
export const NATIVE_GROUP_ID = "chatgpt";
const GATEWAY_ID_PATTERN = /^[a-z0-9-]+$/;

export function gatewayModelId(connectionId: string, modelId: string): string {
    return `gateway:${encodeURIComponent(connectionId)}:${encodeURIComponent(modelId)}`;
}

export interface GatewayModel {
    id: string;
    name: string;
    description: string | null;
}

/** What a Codex model catalog file (`model_catalog_json`) says about one model. */
export interface CatalogEntry {
    displayName: string | null;
    description: string | null;
    efforts: ReasoningEffortOption[];
    defaultEffort: string | null;
    inputModalities: InputModality[] | null;
}

export interface GatewayGroup {
    /** The gateway id; doubles as the select group id. */
    id: string;
    name: string;
    modelIds: string[];
}

export interface Gateway {
    /** `_meta.codex.id`: the `model_providers` entry, `modelProvider` value and select group of this gateway. */
    id: string;
    baseUrl: string;
    headers: Record<string, string>;
    name: string;
    /** Model catalog the gateway serves, when the client told us; Codex cannot list it. */
    models: GatewayModel[];
    /** Model the client wants selected on the gateway, when it told us. */
    model: string | null;
    /** Bearer token Codex sends itself (`experimental_bearer_token`), when the client told us. */
    bearerToken: string | null;
    /** Extra top-level Codex thread-config keys that ride along with the gateway (`_meta.codex.config`). */
    config: JsonObject;
    /** Entries of `config.model_catalog_json`, keyed by slug, when the client pointed at one. */
    catalogEntries: Map<string, CatalogEntry>;
}

/**
 * Client-configured routing for Codex's OpenAI slot (ACP `providers/*`).
 *
 * Gateway credentials are applied per thread through `model_providers` and `modelProvider`.
 * The native connection layer keeps a separate app-server for each provider identity.
 * Nothing is re-routed: each gateway's models are offered next to Codex's in every
 * session's `model` option, and a session moves to a gateway only when one of them is
 * selected. Global routing of Codex's OpenAI slot is upstream's `providers/set`.
 */
export class ProviderRouting {
    private gateways = new Map<string, Gateway>();

    constructor(
        private readonly baseConfig: JsonObject,
        private readonly configuredProvider: string | null,
    ) {}

    copy(): ProviderRouting {
        const copy = new ProviderRouting(
            this.baseConfig,
            this.configuredProvider,
        );
        copy.gateways = new Map(this.gateways);
        return copy;
    }

    /** The first registered gateway, or null. */
    get active(): Gateway | null {
        return this.gateways.values().next().value ?? null;
    }

    gateway(id: string | null): Gateway | null {
        return id === null ? null : (this.gateways.get(id) ?? null);
    }

    private requireGateway(id: string): Gateway {
        const gateway = this.gateways.get(id);
        if (gateway === undefined)
            throw acp.RequestError.invalidParams(
                { gatewayId: id },
                `Gateway "${id}" is not registered`,
            );
        return gateway;
    }

    hasGateway(id: string | null): boolean {
        return id !== null && this.gateways.has(id);
    }

    list(): acp.ListProvidersResponse {
        // Gateways re-route nothing by themselves, so `current` stays native; the registered
        // gateways are reported under `_meta.codex` for clients that want to show them.
        const first = this.active;
        const summary = (gateway: Gateway) => ({
            id: gateway.id,
            name: gateway.name,
            baseUrl: gateway.baseUrl,
            models: gateway.models.map((model) => model.id),
        });
        return {
            providers: [
                {
                    providerId: OPENAI_PROVIDER_ID,
                    supported: ["openai"],
                    required: false,
                    current: {
                        apiType: "openai",
                        baseUrl: this.nativeBaseUrl(),
                    },
                    ...(first
                        ? {
                              _meta: {
                                  codex: {
                                      mode: "catalog",
                                      gateway: summary(first),
                                      gateways: [...this.gateways.values()].map(
                                          summary,
                                      ),
                                  },
                              },
                          }
                        : {}),
                },
            ],
        };
    }

    set(request: acp.SetProviderRequest): void {
        if (request.providerId !== OPENAI_PROVIDER_ID) {
            throw acp.RequestError.invalidParams(
                { providerId: request.providerId },
                `Unknown providerId "${request.providerId}"; only "${OPENAI_PROVIDER_ID}" is configurable`,
            );
        }
        if (request.apiType !== "openai") {
            throw acp.RequestError.invalidParams(
                { apiType: request.apiType },
                `Codex only speaks the OpenAI protocol; got apiType "${request.apiType}"`,
            );
        }
        const baseUrl =
            typeof request.baseUrl === "string" ? request.baseUrl.trim() : "";
        if (!/^https?:\/\//.test(baseUrl)) {
            throw acp.RequestError.invalidParams(
                { baseUrl: request.baseUrl },
                "baseUrl must be an http(s) URL",
            );
        }
        const hints = readHints(request._meta);
        if (
            hints.id === OPENAI_PROVIDER_ID ||
            hints.id === this.configuredProvider
        ) {
            throw acp.RequestError.invalidParams(
                { id: hints.id },
                `_meta.codex.id "${hints.id}" is Codex's own provider; pick another gateway id`,
            );
        }
        this.gateways.set(hints.id, {
            id: hints.id,
            baseUrl,
            headers: { ...(request.headers ?? {}) },
            name: hints.name,
            models: hints.models,
            model: hints.model,
            bearerToken: hints.bearerToken,
            config: hints.config,
            catalogEntries: hints.catalogEntries,
        });
    }

    get hasGateways(): boolean {
        return this.gateways.size > 0;
    }

    /** The gateway serving `modelId`, when one does. */
    gatewayFor(modelId: string): Gateway | null {
        for (const gateway of this.gateways.values()) {
            if (
                gateway.models.some(
                    (model) => gatewayModelId(gateway.id, model.id) === modelId,
                )
            )
                return gateway;
        }
        return null;
    }

    gatewayIdFor(modelId: string): string | null {
        return this.gatewayFor(modelId)?.id ?? null;
    }

    /** True when `modelId` is served by one of the gateways. */
    isGatewayModel(modelId: string): boolean {
        return this.gatewayFor(modelId) !== null;
    }

    /** The select groups the gateways' models sit in, when they share a catalog with Codex's. */
    gatewayGroups(): GatewayGroup[] {
        return [...this.gateways.values()]
            .filter((gateway) => gateway.models.length > 0)
            .map((gateway) => ({
                id: gateway.id,
                name: gateway.name,
                modelIds: gateway.models.map((model) =>
                    gatewayModelId(gateway.id, model.id),
                ),
            }));
    }

    /** Convert a persisted Codex model/provider pair into the public catalog selection. */
    selectionId(
        modelId: string | null,
        provider: string | null,
    ): string | null {
        if (modelId === null) return modelId;
        if (modelId.startsWith("native:"))
            return decodeURIComponent(modelId.slice("native:".length));
        if (modelId.startsWith("gateway:") || !this.hasGateways)
            return modelId;
        return this.hasGateway(provider)
            ? gatewayModelId(provider!, modelId)
            : modelId;
    }

    nativeModel(selection: string, catalog = this.hasGateways): string {
        return !catalog
            ? this.upstreamModel(selection)!
            : selection.startsWith("gateway:")
              ? selection
              : `native:${encodeURIComponent(selection)}`;
    }

    selectionProvider(selection: string): string | null {
        if (!selection.startsWith("gateway:")) return null;
        const match = /^gateway:([^:]+):[^:]+$/.exec(selection);
        const provider = match ? decodeURIComponent(match[1]!) : null;
        if (provider === null || !this.hasGateway(provider))
            throw acp.RequestError.invalidParams(
                undefined,
                "The selected provider connection or model is unavailable",
            );
        return provider;
    }

    modelAliases(): Array<{ id: string; upstream: string; catalog?: string }> {
        return [...this.gateways.values()].flatMap((gateway) =>
            gateway.models.map((model) => ({
                id: gatewayModelId(gateway.id, model.id),
                upstream: model.id,
                ...(typeof gateway.config["model_catalog_json"] === "string"
                    ? { catalog: gateway.config["model_catalog_json"] }
                    : {}),
            })),
        );
    }

    /** Unknown gateway IDs must never fall through to native billing. */
    upstreamModel(selectionId: string | null): string | null {
        if (!selectionId?.startsWith("gateway:")) return selectionId;
        const gateway = this.gatewayFor(selectionId);
        const model = gateway?.models.find(
            (model) => gatewayModelId(gateway.id, model.id) === selectionId,
        );
        if (!model)
            throw acp.RequestError.invalidParams(
                { model: selectionId },
                "The selected provider connection or model is unavailable",
            );
        return model.id;
    }

    /**
     * Disabling an unknown provider is a no-op, per the ACP providers RFD. `_meta.codex.id`
     * removes that gateway only; without it every gateway goes.
     */
    disable(request: acp.DisableProviderRequest): void {
        if (request.providerId !== OPENAI_PROVIDER_ID) return;
        const id = readGatewayId((request as { _meta?: unknown })._meta);
        if (id === null) this.gateways.clear();
        else this.gateways.delete(id);
    }

    /** Base thread config; with a gateway's overrides and `model_providers` entry when the thread runs on it. */
    threadConfig(gatewayId: string | null): JsonObject {
        if (gatewayId === null) return this.baseConfig;
        return this.applyGateway(this.baseConfig, this.requireGateway(gatewayId));
    }

    /**
     * Moves a live thread's config (which also carries per-session keys such as
     * `projects`) onto a gateway or back to native.
     */
    routeConfig(config: JsonObject, gatewayId: string | null): JsonObject {
        return this.rebind(config, this, gatewayId);
    }

    /**
     * Top-level keys this routing adds on top of the base config. A later routing
     * change restores or removes them from a live thread's config (`rebind`).
     */
    overrideKeys(): string[] {
        const keys = new Set<string>();
        for (const gateway of this.gateways.values())
            for (const key of Object.keys(gateway.config)) keys.add(key);
        return [...keys];
    }

    /**
     * Re-targets a live thread's config (which also carries per-session keys such as
     * `projects`) from `previous` routing to this one: every previous gateway's override
     * keys fall back to the base config, then the target gateway is applied.
     */
    rebind(
        config: JsonObject,
        previous: ProviderRouting,
        gatewayId: string | null,
    ): JsonObject {
        const next: JsonObject = { ...config };
        for (const key of previous.overrideKeys()) {
            if (key in this.baseConfig) next[key] = this.baseConfig[key]!;
            else delete next[key];
        }
        // Only the target gateway's entry may remain: a thread moved between gateways must not
        // keep the previous one's `model_providers` entry (and its bearer token) in its config.
        delete next["model_providers"];
        if (isRecord(this.baseConfig["model_providers"]))
            next["model_providers"] = this.baseConfig["model_providers"];
        if (gatewayId === null) return next;
        return this.applyGateway(next, this.requireGateway(gatewayId));
    }

    private applyGateway(config: JsonObject, gateway: Gateway): JsonObject {
        const existing = isRecord(config["model_providers"])
            ? config["model_providers"]
            : {};
        const entry: JsonObject = {
            name: gateway.name,
            base_url: gateway.baseUrl,
            // Codex 0.153 dropped chat completions; the Responses API is the only wire protocol left.
            wire_api: "responses",
            http_headers: {
                "X-Client-Feature-ID": "codex",
                ...gateway.headers,
            },
        };
        // How DeepSeek's official Codex integration passes the key; Codex adds the Authorization header itself.
        if (gateway.bearerToken !== null)
            entry["experimental_bearer_token"] = gateway.bearerToken;
        return {
            ...config,
            ...gateway.config,
            model_providers: { ...existing, [gateway.id]: entry },
        };
    }

    /**
     * The catalog a session should show: Codex's models followed by every gateway's, in
     * registration order.
     */
    catalog(codexCatalog: Model[]): Model[] {
        const own: Model[] = [];
        for (const gateway of this.gateways.values()) {
            for (const model of gateway.models)
                own.push({
                    ...gatewayModel(
                        model,
                        codexCatalog.find((entry) => entry.model === model.id),
                        gateway.catalogEntries.get(model.id),
                    ),
                    id: gatewayModelId(gateway.id, model.id),
                });
        }
        return [...codexCatalog, ...own];
    }

    private nativeBaseUrl(): string {
        const providers = this.baseConfig["model_providers"];
        if (this.configuredProvider && isRecord(providers)) {
            const entry = providers[this.configuredProvider];
            const baseUrl = isRecord(entry) ? entry["base_url"] : undefined;
            if (typeof baseUrl === "string" && baseUrl.length > 0)
                return baseUrl;
        }
        return DEFAULT_OPENAI_BASE_URL;
    }
}

/**
 * Hints ACP does not standardize yet. `_meta.alwith.{model, models}` is what ALwith
 * Desktop sends with `providers/set`; `_meta.codex.name` labels the provider,
 * `_meta.codex.bearerToken` is the key Codex sends itself, and `_meta.codex.config` is
 * extra top-level thread config (`model_catalog_json`, `web_search`, …) that only
 * applies while this gateway is active.
 */
function readHints(meta: unknown): {
    id: string;
    models: GatewayModel[];
    model: string | null;
    name: string;
    bearerToken: string | null;
    config: JsonObject;
    catalogEntries: Map<string, CatalogEntry>;
} {
    const root = isRecord(meta) ? meta : {};
    const alwith = isRecord(root["alwith"]) ? root["alwith"] : {};
    const codex = isRecord(root["codex"]) ? root["codex"] : {};
    const id = readGatewayId(meta);
    if (id === null)
        throw acp.RequestError.invalidParams(
            undefined,
            "providers/set needs _meta.codex.id: the gateway id",
        );
    const models: GatewayModel[] = [];
    if (Array.isArray(alwith["models"])) {
        for (const [index, entry] of alwith["models"].entries()) {
            if (
                !isRecord(entry) ||
                typeof entry["id"] !== "string" ||
                entry["id"].length === 0 ||
                typeof entry["label"] !== "string" ||
                entry["label"].length === 0 ||
                (entry["description"] !== undefined &&
                    entry["description"] !== null &&
                    typeof entry["description"] !== "string")
            )
                throw acp.RequestError.invalidParams(
                    { index, entry },
                    "_meta.alwith.models entries need a non-empty id and label, and a string or null description",
                );
            models.push({
                id: entry["id"],
                name: entry["label"],
                description: entry["description"] ?? null,
            });
        }
    }
    const model =
        typeof alwith["model"] === "string" && alwith["model"].length > 0
            ? alwith["model"]
            : null;
    const name = codex["name"];
    if (typeof name !== "string" || name.length === 0)
        throw acp.RequestError.invalidParams(
            { name },
            "providers/set needs _meta.codex.name: the gateway's display name",
        );
    const bearerToken =
        typeof codex["bearerToken"] === "string" &&
        codex["bearerToken"].length > 0
            ? codex["bearerToken"]
            : null;
    const rawConfig = codex["config"];
    if (rawConfig !== undefined && !isRecord(rawConfig)) {
        throw acp.RequestError.invalidParams(
            { config: rawConfig },
            "_meta.codex.config must be an object of top-level Codex config keys",
        );
    }
    const config: JsonObject = {};
    if (isRecord(rawConfig)) {
        for (const [key, value] of Object.entries(rawConfig)) {
            if (key === "model_providers")
                throw acp.RequestError.invalidParams(
                    { config: rawConfig },
                    "_meta.codex.config cannot set model_providers; that entry is derived from baseUrl and headers",
                );
            config[key] = value as JsonObject[string];
        }
    }
    if (models.length === 0) {
        throw acp.RequestError.invalidParams(
            undefined,
            '_meta.codex.mode "catalog" needs _meta.alwith.models: the models offered next to Codex\'s',
        );
    }
    const catalogPath = config["model_catalog_json"];
    const catalogEntries =
        typeof catalogPath === "string"
            ? readCatalogFile(catalogPath)
            : new Map<string, CatalogEntry>();
    return {
        id,
        models,
        model,
        name,
        bearerToken,
        config,
        catalogEntries,
    };
}

/** `_meta.codex.id`: which gateway a `providers/set` or `providers/disable` addresses. */
function readGatewayId(meta: unknown): string | null {
    const root = isRecord(meta) ? meta : {};
    const codex = isRecord(root["codex"]) ? root["codex"] : {};
    const raw = codex["id"];
    if (raw === undefined) return null;
    if (typeof raw !== "string" || !GATEWAY_ID_PATTERN.test(raw)) {
        throw acp.RequestError.invalidParams(
            { id: raw },
            "_meta.codex.id must match [a-z0-9-]+",
        );
    }
    if (raw === NATIVE_GROUP_ID) {
        throw acp.RequestError.invalidParams(
            { id: raw },
            `_meta.codex.id "${NATIVE_GROUP_ID}" is the native model group`,
        );
    }
    return raw;
}

/**
 * Reads a Codex model catalog file so gateway models carry their real reasoning levels,
 * modalities and names; Codex loads the same file per thread but `model/list` never
 * reflects it.
 */
function readCatalogFile(catalogPath: string): Map<string, CatalogEntry> {
    const resolved = catalogPath.startsWith("~/")
        ? path.join(os.homedir(), catalogPath.slice(2))
        : catalogPath;
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(resolved, "utf8"));
    } catch (error) {
        throw acp.RequestError.invalidParams(
            { model_catalog_json: catalogPath },
            `model_catalog_json could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
    }
    const models =
        isRecord(parsed) && Array.isArray(parsed["models"])
            ? parsed["models"]
            : null;
    if (models === null)
        throw acp.RequestError.invalidParams(
            { model_catalog_json: catalogPath },
            "model_catalog_json must be {models: [...]} as Codex expects",
        );
    const entries = new Map<string, CatalogEntry>();
    const invalid = (index: number, reason: string) =>
        acp.RequestError.invalidParams(
            { model_catalog_json: catalogPath, index },
            `model_catalog_json entry ${index} ${reason}`,
        );
    for (const [index, entry] of models.entries()) {
        if (!isRecord(entry) || typeof entry["slug"] !== "string")
            throw invalid(index, "needs a string slug");
        const levels = entry["supported_reasoning_levels"];
        if (!Array.isArray(levels))
            throw invalid(index, "needs a supported_reasoning_levels array");
        const efforts: ReasoningEffortOption[] = levels.map((level) => {
            if (
                !isRecord(level) ||
                typeof level["effort"] !== "string" ||
                typeof level["description"] !== "string"
            )
                throw invalid(
                    index,
                    "has a reasoning level without a string effort and description",
                );
            return {
                reasoningEffort: level["effort"],
                description: level["description"],
            };
        });
        const rawModalities = entry["input_modalities"];
        let modalities: InputModality[] | null = null;
        if (rawModalities !== undefined) {
            if (
                !Array.isArray(rawModalities) ||
                !rawModalities.every(
                    (value) => value === "text" || value === "image",
                )
            )
                throw invalid(
                    index,
                    'needs input_modalities of "text" and "image" only',
                );
            modalities = rawModalities;
        }
        entries.set(entry["slug"], {
            displayName:
                typeof entry["display_name"] === "string"
                    ? entry["display_name"]
                    : null,
            description:
                typeof entry["description"] === "string"
                    ? entry["description"]
                    : null,
            efforts,
            defaultEffort:
                typeof entry["default_reasoning_level"] === "string"
                    ? entry["default_reasoning_level"]
                    : null,
            inputModalities: modalities,
        });
    }
    return entries;
}

/** Synthesizes a Codex `Model` for a gateway model so the session catalog stays one shape. */
function gatewayModel(
    model: GatewayModel,
    template: Model | undefined,
    entry: CatalogEntry | undefined,
): Model {
    if (entry === undefined && template === undefined)
        throw acp.RequestError.invalidParams(
            { model: model.id },
            `Gateway model "${model.id}" is neither in the gateway's model_catalog_json nor a Codex model`,
        );
    // Mirrors Codex's ModelInfo -> ModelPreset conversion for catalog entries.
    const efforts = entry ? entry.efforts : template!.supportedReasoningEfforts;
    const defaultEffort = entry
        ? (entry.defaultEffort ?? "none")
        : template!.defaultReasoningEffort;
    return {
        id: model.id,
        model: model.id,
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
        displayName:
            model.name !== model.id
                ? model.name
                : (entry?.displayName ?? model.name),
        description:
            model.description ??
            (entry ? (entry.description ?? "") : template!.description),
        modelSpecialty: null,
        hidden: false,
        supportedReasoningEfforts: efforts,
        defaultReasoningEffort: defaultEffort,
        inputModalities: entry
            ? (entry.inputModalities ?? ["text", "image"])
            : template!.inputModalities,
        supportsPersonality: false,
        multiAgentVersion: null,
        additionalSpeedTiers: [],
        serviceTiers: [],
        defaultServiceTier: null,
        availableAccessPrograms: null,
        isDefault: false,
    };
}
