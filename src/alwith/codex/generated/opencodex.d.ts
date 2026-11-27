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

/** What opencodex's Claude login returns; `expires` is already five minutes ahead of the real expiry. */
export interface OcxOAuthCredentials {
    access: string;
    refresh: string;
    expires: number;
    email?: string;
    plan?: string | null;
}

export class AnthropicOAuthFlow {
    constructor(controller: {signal?: AbortSignal});
    generateState(): string;
    generateAuthUrl(state: string, redirectUri: string): Promise<{url: string}>;
    exchangeToken(code: string, state: string, redirectUri: string): Promise<OcxOAuthCredentials>;
}

/** Throws when the grant is revoked or reused; the caller then asks for a new login. */
export function refreshAnthropicToken(refreshToken: string): Promise<OcxOAuthCredentials>;

/** Used percentages and reset times in epoch milliseconds; a window Claude does not report is absent. */
export interface OcxProviderQuota {
    fiveHourPercent?: number;
    fiveHourResetAt?: number;
    weeklyPercent?: number;
    weeklyResetAt?: number;
    /** The weekly limits of single model families, labelled with the family ("Fable"). */
    customWindows?: Array<{label: string; percent: number; resetAt?: number}>;
}

/** Null when Claude refused the request or answered without a usable window. */
export function readAnthropicUsageQuota(accessToken: string): Promise<OcxProviderQuota | null>;
