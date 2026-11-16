import {RequestError} from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {MAX_ACP_RESPONSE_BYTES} from "../catalog-protocol";

export function catalogFieldBytes(result: unknown, bytes: number): Record<string, number> {
    const fields: Record<string, number> = {};
    let known = 0;
    if (result !== null && typeof result === "object") {
        for (const field of ["marketplaces", "marketplaceLoadErrors", "featuredPluginIds"]) {
            const value = (result as Record<string, unknown>)[field];
            if (value === undefined) continue;
            fields[field] = Buffer.byteLength(JSON.stringify(value));
            known += fields[field]!;
        }
    }
    fields.other = Math.max(0, bytes - known);
    return fields;
}

function tooLarge(method: string, bytes: number, result?: unknown): RequestError {
    return RequestError.invalidRequest({
        reason: "catalog_response_too_large", method, bytes, limitBytes: MAX_ACP_RESPONSE_BYTES, retryable: false, fieldBytes: catalogFieldBytes(result, bytes),
    }, "Catalog response exceeds the ACP transport limit; use the paged catalog method");
}

/** Match ACP's public error representation for measurement without replacing the original exception. */
function responseError(error: unknown, signal?: AbortSignal): RequestError {
    const value = error !== null && typeof error === "object" ? error as Record<string, unknown> : null;
    if (signal?.aborted && (value?.name === "AbortError" || value?.code === "ABORT_ERR")) {
        const reason: unknown = signal.reason;
        return reason instanceof RequestError && reason.code === -32800 ? reason : RequestError.requestCancelled(reason);
    }
    if (error instanceof RequestError) return error;
    if (value?.name === "ZodError" && Array.isArray(value.issues) && typeof value.format === "function")
        return RequestError.invalidParams((value.format as () => unknown).call(error));
    const details = error instanceof Error ? error.message : typeof value?.message === "string" ? value.message : undefined;
    try { return RequestError.internalError(details ? JSON.parse(details) as unknown : {}); }
    catch { return RequestError.internalError({details}); }
}

/** Reject a result in its handler, before the transport can close a shared connection. */
export async function boundedResponse<T>(
    id: string | number | null, method: string, action: () => Promise<T>, signal?: AbortSignal,
): Promise<T> {
    let result: T;
    try {
        result = await action();
    } catch (error) {
        const rpc = responseError(error, signal);
        const bytes = Buffer.byteLength(JSON.stringify({jsonrpc: "2.0", id, ...rpc.toResult()}));
        if (bytes > MAX_ACP_RESPONSE_BYTES) throw tooLarge(method, bytes);
        throw error;
    }
    const bytes = Buffer.byteLength(JSON.stringify({jsonrpc: "2.0", id, result}));
    if (bytes > MAX_ACP_RESPONSE_BYTES) throw tooLarge(method, bytes, result);
    return result;
}
