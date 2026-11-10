import {
    bridgeToResponsesSSE,
    createAnthropicAdapter,
    createTranslatorBudget,
    formatErrorResponse,
    parseRequest,
    type OcxParsedRequest,
} from "./generated/opencodex.js";

export interface MessagesUpstream {
    baseUrl: string;
    apiKey: string;
    authMode?: "key" | "oauth";
    signal: AbortSignal;
    /** The proxy's transport: it owns the native network route and the diagnostics. */
    send(url: URL, init: {method: string; headers: Record<string, string>; body: string}): Promise<Response>;
}

/** opencodex names itself after Anthropic's SDK; the request is ours. */
const USER_AGENT = "codex-acp";

/** Anthropic returns the declared name unchanged, so only the flattened `namespace__name` spelling needs restoring. */
function toolNames(parsed: OcxParsedRequest) {
    const namespaced = new Map<string, {namespace: string; name: string; freeform?: true}>();
    const freeform = new Set<string>();
    const search = new Set<string>();
    for (const tool of parsed.context.tools ?? []) {
        const wire = tool.namespace ? `${tool.namespace}__${tool.name}` : tool.name;
        if (tool.namespace) namespaced.set(wire, {namespace: tool.namespace, name: tool.name, ...(tool.freeform ? {freeform: true as const} : {})});
        if (tool.freeform) freeform.add(wire);
        if (tool.toolSearch) search.add(wire);
    }
    return {namespaced, freeform, search};
}

/**
 * Answers one Codex Responses request from an Anthropic Messages endpoint.
 * The only Responses-to-Messages translation in this adapter: another translator replaces this function.
 */
export async function anthropicResponses(body: string, upstream: MessagesUpstream): Promise<Response> {
    const authMode = upstream.authMode ?? "key";
    if (authMode !== "key" && authMode !== "oauth") throw new Error("Unknown Anthropic authentication mode");
    if (authMode === "oauth") {
        const target = new URL(upstream.baseUrl);
        if (target.origin !== "https://api.anthropic.com" || target.username || target.password || target.search || target.hash || !["", "/", "/v1", "/v1/"].includes(target.pathname)) {
            throw new Error("Claude OAuth credentials may only be sent to https://api.anthropic.com");
        }
    }
    const parsed = parseRequest(JSON.parse(body));
    if (!parsed.stream) throw new Error("Anthropic Messages routing needs a streaming Responses request");
    const budget = createTranslatorBudget();
    const adapter = createAnthropicAdapter({name: "anthropic", adapter: "anthropic", baseUrl: upstream.baseUrl, apiKey: upstream.apiKey, authMode});
    const request = await adapter.buildRequest(parsed, {headers: new Headers(), translatorBudget: budget, abortSignal: upstream.signal});
    const response = await upstream.send(new URL(request.url), {
        method: request.method,
        headers: authMode === "oauth" ? request.headers : {...request.headers, "User-Agent": USER_AGENT},
        body: request.body,
    });
    if (!response.ok) {
        const text = await response.text();
        return formatErrorResponse(response.status, "upstream_error", adapter.formatErrorBody(response.status, response.headers, text) || text.slice(0, 400), {
            retryAfter: response.headers.get("retry-after"),
        });
    }
    const names = toolNames(parsed);
    const events = bridgeToResponsesSSE(adapter.parseStream(response, budget), parsed.modelId, names.namespaced, names.freeform, names.search, () => {}, 2_000, {
        translatorBudget: budget,
    });
    return new Response(events, {headers: {"content-type": "text/event-stream"}});
}
