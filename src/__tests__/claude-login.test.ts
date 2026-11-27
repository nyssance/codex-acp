import {mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import {claudeAccessToken, claudeLogin, claudeLoginStatus, claudeLogout, claudeUsage} from "../alwith/codex/claudeLogin";

const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const realFetch = globalThis.fetch;
let directory: string;
let file: string;
let tokenRequests: Record<string, unknown>[];
let tokenResponse: () => Response;
let usageResponse: () => Response;

function tokens(access: string, refresh: string): Response {
    return Response.json({access_token: access, refresh_token: refresh, expires_in: 3600, account: {email_address: "user@example.com"}});
}

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "claude-login-"));
    file = join(directory, "nested", "claude-login.json");
    tokenRequests = [];
    tokenResponse = () => tokens("access-1", "refresh-1");
    usageResponse = () => new Response(null, {status: 403});
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.startsWith("http://localhost:") || url.startsWith("http://127.0.0.1:")) return realFetch(input, init);
        if (url === TOKEN_URL) {
            tokenRequests.push(JSON.parse(String(init?.body)));
            return tokenResponse();
        }
        if (url === "https://api.anthropic.com/api/oauth/usage") {
            expect(new Headers(init?.headers).get("authorization")).toBe("Bearer access-1");
            return usageResponse();
        }
        // The profile read only decorates the credential; without it the login stands.
        return new Response(null, {status: 404});
    });
});

afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(directory, {recursive: true, force: true});
});

/** Stands in for the browser: approves and follows Claude's redirect back to the adapter. */
function approve(change: (redirect: URL) => void = () => {}) {
    return async (authorize: string) => {
        const url = new URL(authorize);
        expect(url.origin + url.pathname).toBe("https://claude.ai/oauth/authorize");
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        const redirect = new URL(url.searchParams.get("redirect_uri")!);
        expect(redirect.hostname).toBe("localhost");
        redirect.searchParams.set("code", "granted-code");
        redirect.searchParams.set("state", url.searchParams.get("state")!);
        change(redirect);
        const page = await realFetch(redirect);
        return page.status;
    };
}

it("signs in through the browser redirect and keeps the login private to the user", async () => {
    expect(await claudeLoginStatus(file)).toEqual({signedIn: false, email: null, plan: null});
    expect(await claudeLogin(file, undefined, approve())).toEqual({signedIn: true, email: "user@example.com", plan: null});
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]).toMatchObject({grant_type: "authorization_code", code: "granted-code"});
    expect(tokenRequests[0]!["code_verifier"]).toEqual(expect.any(String));
    if (process.platform !== "win32") expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await claudeAccessToken(file)).toBe("access-1");
    expect(await claudeLoginStatus(file)).toEqual({signedIn: true, email: "user@example.com", plan: null});
});

it("refuses a redirect that carries another state and a consent that was denied", async () => {
    let status = 0;
    const foreign = approve(redirect => redirect.searchParams.set("state", "another"));
    const denied = approve(redirect => {
        redirect.searchParams.delete("code");
        redirect.searchParams.set("error", "access_denied");
    });
    await expect(claudeLogin(file, undefined, async url => {
        status = await foreign(url);
        await denied(url);
    })).rejects.toThrow("access_denied");
    expect(status).toBe(400);
    expect(tokenRequests).toEqual([]);
    expect(await claudeLoginStatus(file)).toEqual({signedIn: false, email: null, plan: null});
});

it("stops waiting when the request is cancelled", async () => {
    const abort = new AbortController();
    await expect(claudeLogin(file, abort.signal, async () => abort.abort(new Error("cancelled by the user")))).rejects.toThrow("cancelled by the user");
    expect(tokenRequests).toEqual([]);
});

it("renews an expired token once for concurrent requests and keeps the rotated refresh token", async () => {
    await claudeLogin(file, undefined, approve());
    tokenRequests = [];
    tokenResponse = () => tokens("access-2", "refresh-2");
    const later = Date.now() + 2 * 3600_000;
    expect(await Promise.all([claudeAccessToken(file, later), claudeAccessToken(file, later)])).toEqual(["access-2", "access-2"]);
    expect(tokenRequests).toEqual([expect.objectContaining({grant_type: "refresh_token", refresh_token: "refresh-1"})]);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({access: "access-2", refresh: "refresh-2", email: "user@example.com"});
    // The renewed token is used until it expires in turn.
    expect(await claudeAccessToken(file)).toBe("access-2");
    expect(tokenRequests).toHaveLength(1);
});

it("asks for a new sign-in when the login is absent, revoked or malformed", async () => {
    await expect(claudeAccessToken(file)).rejects.toThrow("Not signed in to Claude");
    await claudeLogin(file, undefined, approve());
    tokenResponse = () => Response.json({error: "invalid_grant"}, {status: 400});
    await expect(claudeAccessToken(file, Date.now() + 2 * 3600_000)).rejects.toThrow("sign in again");
    await writeFile(file, "{}");
    await expect(claudeAccessToken(file)).rejects.toThrow("malformed");
});

it("signs out by removing the login", async () => {
    await claudeLogin(file, undefined, approve());
    expect(await claudeLogout(file)).toEqual({signedIn: false, email: null, plan: null});
    await expect(claudeAccessToken(file)).rejects.toThrow("Not signed in to Claude");
    expect(await claudeLogout(file)).toEqual({signedIn: false, email: null, plan: null});
});

it("reports the windows Claude lists, shared limits first, and fails when there are none", async () => {
    await claudeLogin(file, undefined, approve());
    usageResponse = () => Response.json({
        five_hour: {utilization: 12, resets_at: "2026-11-27T20:00:00Z"},
        seven_day: {utilization: 24, resets_at: "2026-12-02T15:00:00Z"},
        seven_day_fable: {utilization: 44, resets_at: "2026-12-02T15:00:00Z"},
    });
    const week = Date.parse("2026-12-02T15:00:00Z") / 1000;
    expect(await claudeUsage(file)).toEqual({windows: [
        {label: null, usedPercent: 12, windowDurationMins: 300, resetsAt: Date.parse("2026-11-27T20:00:00Z") / 1000},
        {label: null, usedPercent: 24, windowDurationMins: 10_080, resetsAt: week},
        {label: "Fable", usedPercent: 44, windowDurationMins: 10_080, resetsAt: week},
    ]});
    usageResponse = () => Response.json({seven_day: {utilization: 5}});
    expect(await claudeUsage(file)).toEqual({windows: [{label: null, usedPercent: 5, windowDurationMins: 10_080, resetsAt: null}]});
    usageResponse = () => new Response(null, {status: 403});
    await expect(claudeUsage(file)).rejects.toThrow("did not report the subscription usage");
});
