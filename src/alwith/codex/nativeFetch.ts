import {randomBytes} from "node:crypto";
import {NativeNetworkTransport, nativeNetworkError} from "./nativeNetworkTransport";

/** Auxiliary adapter HTTP calls use the same native transport as Responses. */
export async function nativeFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const native = NativeNetworkTransport.fromEnvironment();
    if (!native) return fetch(input, init);
    let target = new URL(input);
    let method = init.method ?? "GET";
    let body = init.body;
    const headers = new Headers(init.headers);
    const requestId = randomBytes(12).toString("hex");
    for (let redirects = 0; ; redirects++) {
        if (!["http:", "https:"].includes(target.protocol) || target.username || target.password)
            throw new Error("Invalid native HTTP target");
        const route = native.route(target, false, requestId);
        const requestHeaders = new Headers(headers);
        for (const [name, value] of Object.entries(route.headers)) requestHeaders.set(name, value);
        const response = await fetch(route.url, {
            ...init,
            method,
            body,
            headers: requestHeaders,
            redirect: "manual",
            // Only loopback traffic uses Bun. Never apply an environment proxy to it.
            proxy: false,
        });
        const error = nativeNetworkError(response.headers.get("x-alwith-native-error"));
        if (error) {
            await response.body?.cancel();
            throw error;
        }
        if (![301, 302, 303, 307, 308].includes(response.status) || init.redirect === "manual") return response;
        const location = response.headers.get("location");
        if (!location) return response;
        await response.body?.cancel();
        if (init.redirect === "error" || redirects === 20) throw new Error("Native HTTP redirect rejected");
        const next = new URL(location, target);
        if (next.origin !== target.origin) {
            for (const header of ["authorization", "cookie", "proxy-authorization", "host"]) headers.delete(header);
        }
        if ((response.status === 303 && method !== "HEAD") || ([301, 302].includes(response.status) && method === "POST")) {
            method = "GET";
            body = undefined;
            headers.delete("content-type");
            headers.delete("content-length");
        }
        target = next;
    }
}
