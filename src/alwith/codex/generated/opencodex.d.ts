/** The part of opencodex's translation core that `anthropicMessages.ts` calls; see `opencodex.entry.mjs`. */

export interface OcxTool {
    name: string;
    namespace?: string;
    freeform?: boolean;
    toolSearch?: boolean;
}

export interface OcxParsedRequest {
    modelId: string;
    stream: boolean;
    context: {tools?: OcxTool[]};
}

export interface TranslatorBudget {
    dispose(): void;
}

export interface AdapterRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
}

export interface ProviderAdapter {
    formatErrorBody(status: number, headers: Headers, payloadText: string): string;
    buildRequest(
        parsed: OcxParsedRequest,
        incoming: {headers: Headers; translatorBudget: TranslatorBudget; abortSignal: AbortSignal},
    ): Promise<AdapterRequest>;
    parseStream(response: Response, budget: TranslatorBudget): AsyncGenerator<object>;
}

export function parseRequest(body: unknown): OcxParsedRequest;

export function createAnthropicAdapter(provider: {
    name: string;
    adapter: "anthropic";
    baseUrl: string;
    apiKey: string;
    authMode: "key" | "oauth";
}): ProviderAdapter;

export function createTranslatorBudget(): TranslatorBudget;

/** The error body Codex classifies: context overflow, rate limit, credentials, and the rest. */
export function formatErrorResponse(status: number, type: string, message: string, options?: {retryAfter?: string | null}): Response;

export function bridgeToResponsesSSE(
    events: AsyncIterable<object>,
    modelId: string,
    toolNsMap: Map<string, {namespace: string; name: string; freeform?: true}>,
    freeformToolNames: Set<string>,
    toolSearchToolNames: Set<string>,
    onCancel: () => void,
    heartbeatMs: number,
    options: {translatorBudget: TranslatorBudget},
): ReadableStream<Uint8Array>;
