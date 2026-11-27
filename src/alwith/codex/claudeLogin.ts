import {mkdir, readFile, rename, rm, writeFile} from "node:fs/promises";
import {dirname} from "node:path";
import open from "open";
import lockfile from "proper-lockfile";
import {AnthropicOAuthFlow, readAnthropicUsageQuota, refreshAnthropicToken, type OcxOAuthCredentials} from "./generated/opencodex.js";

/**
 * The application's own Claude subscription login: one credential in a file the host names, private
 * to the OS user. The host never reads the file; it asks for the status, a login or a logout. The
 * proxy takes the access token from it for every request and renews it when it has expired.
 * The login of another application (Claude Code) is never read: renewing with its refresh token
 * would end that application's login.
 */
export interface ClaudeLoginStatus {
    signedIn: boolean;
    email: string | null;
    plan: string | null;
}

/** One limit of the subscription, in the shape of Codex's `RateLimitWindow`; `label` names a model family's own limit. */
export interface ClaudeUsageWindow {
    label: string | null;
    usedPercent: number;
    windowDurationMins: number;
    /** Epoch seconds. */
    resetsAt: number | null;
}

interface Credential {
    access: string;
    refresh: string;
    /** opencodex stamps this five minutes ahead of the real expiry. */
    expires: number;
    email: string | null;
    plan: string | null;
}

const LOGIN_TIMEOUT_MS = 300_000;
/** A renewal is one token request; a lock older than this belongs to a process that died. */
const LOCK = {realpath: false, stale: 30_000, retries: {retries: 40, minTimeout: 50, maxTimeout: 500}} as const;

const SIGNED_IN_PAGE = page("Signed in", "You can close this tab and return to the application.");

function page(title: string, message: string): string {
    const escape = (text: string) => text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
    return `<!doctype html><html><head><meta charset="utf-8"><title>${escape(title)}</title></head>`
        + `<body style="font-family:system-ui,sans-serif;text-align:center;padding:4rem"><h2>${escape(title)}</h2><p>${escape(message)}</p></body></html>`;
}

function credential(value: OcxOAuthCredentials): Credential {
    if (!value.access || !value.refresh) throw new Error("Claude returned a login without a token");
    return {access: value.access, refresh: value.refresh, expires: value.expires, email: value.email ?? null, plan: value.plan ?? null};
}

async function read(path: string): Promise<Credential | null> {
    let text: string;
    try {
        text = await readFile(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
    const value = JSON.parse(text) as Credential;
    if (typeof value.access !== "string" || typeof value.refresh !== "string" || !Number.isFinite(value.expires))
        throw new Error("The Claude login file is malformed");
    return value;
}

async function write(path: string, value: Credential): Promise<void> {
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value), {mode: 0o600});
    await rename(temporary, path);
}

async function locked<T>(path: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(path), {recursive: true});
    const release = await lockfile.lock(path, LOCK);
    try {
        return await operation();
    } finally {
        await release();
    }
}

function status(value: Credential | null): ClaudeLoginStatus {
    return value === null ? {signedIn: false, email: null, plan: null} : {signedIn: true, email: value.email, plan: value.plan};
}

export async function claudeLoginStatus(path: string): Promise<ClaudeLoginStatus> {
    return status(await read(path));
}

export async function claudeLogout(path: string): Promise<ClaudeLoginStatus> {
    await locked(path, () => rm(path, {force: true}));
    return status(null);
}

const renewals = new Map<string, Promise<string>>();

/** The access token for one request. Every process of the application shares the file, so a renewal holds its lock. */
export async function claudeAccessToken(path: string, now = Date.now()): Promise<string> {
    const current = await read(path);
    if (current === null) throw new Error("Not signed in to Claude. Sign in from the model provider settings.");
    if (current.expires > now) return current.access;
    const pending = renewals.get(path);
    if (pending) return pending;
    const renewal = locked(path, async () => {
        // Another process may have renewed while this one waited for the lock.
        const latest = await read(path);
        if (latest === null) throw new Error("Not signed in to Claude. Sign in from the model provider settings.");
        if (latest.expires > now) return latest.access;
        let renewed: OcxOAuthCredentials;
        try {
            renewed = await refreshAnthropicToken(latest.refresh);
        } catch (error) {
            throw new Error(`The Claude login could not be renewed; sign in again from the model provider settings. ${error instanceof Error ? error.message : String(error)}`);
        }
        const next = {...credential(renewed), email: renewed.email ?? latest.email, plan: renewed.plan === undefined ? latest.plan : renewed.plan};
        await write(path, next);
        return next.access;
    }).finally(() => renewals.delete(path));
    renewals.set(path, renewal);
    return renewal;
}

const FIVE_HOURS_MINS = 300;
const WEEK_MINS = 10_080;

/** The limits Claude reports for the login: the five-hour and weekly windows, then each model family's weekly limit. */
export async function claudeUsage(path: string): Promise<{windows: ClaudeUsageWindow[]}> {
    const quota = await readAnthropicUsageQuota(await claudeAccessToken(path));
    if (quota === null) throw new Error("Claude did not report the subscription usage");
    const seconds = (millis: number | undefined) => millis === undefined ? null : Math.round(millis / 1000);
    const windows: ClaudeUsageWindow[] = [];
    if (quota.fiveHourPercent !== undefined)
        windows.push({label: null, usedPercent: quota.fiveHourPercent, windowDurationMins: FIVE_HOURS_MINS, resetsAt: seconds(quota.fiveHourResetAt)});
    if (quota.weeklyPercent !== undefined)
        windows.push({label: null, usedPercent: quota.weeklyPercent, windowDurationMins: WEEK_MINS, resetsAt: seconds(quota.weeklyResetAt)});
    for (const family of quota.customWindows ?? [])
        windows.push({label: family.label, usedPercent: family.percent, windowDurationMins: WEEK_MINS, resetsAt: seconds(family.resetAt)});
    return {windows};
}

/**
 * Opens the browser at Claude's consent page and waits for its redirect to this process.
 * The redirect is what Claude Code uses: `http://localhost:<port>/callback`.
 */
export async function claudeLogin(
    path: string,
    signal?: AbortSignal,
    openBrowser: (url: string) => Promise<unknown> = url => open(url),
): Promise<ClaudeLoginStatus> {
    const timeout = AbortSignal.timeout(LOGIN_TIMEOUT_MS);
    const deadline = AbortSignal.any([timeout, ...(signal ? [signal] : [])]);
    const flow = new AnthropicOAuthFlow({signal: deadline});
    const state = flow.generateState();
    const {promise: code, resolve, reject} = Promise.withResolvers<string>();
    // The wait below may start after a cancellation has already rejected it.
    code.catch(() => {});
    const answer = (request: Request): Response => {
        const url = new URL(request.url);
        if (url.pathname !== "/callback") return new Response(null, {status: 404});
        const html = (body: string, status: number) => new Response(body, {status, headers: {"content-type": "text/html", connection: "close"}});
        if (url.searchParams.get("state") !== state) return html(page("Sign-in failed", "This page does not belong to the sign-in that is waiting."), 400);
        const error = url.searchParams.get("error");
        const received = url.searchParams.get("code");
        if (error !== null || received === null) {
            const reason = url.searchParams.get("error_description") ?? error ?? "Claude returned no authorization code";
            reject(new Error(`Claude sign-in failed: ${reason}`));
            return html(page("Sign-in failed", reason), 400);
        }
        resolve(received);
        return html(SIGNED_IN_PAGE, 200);
    };
    // `localhost` is the registered redirect host; Windows resolves it to ::1 first.
    const server = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: answer});
    const servers = [server];
    try {
        servers.push(Bun.serve({hostname: "::1", port: server.port, fetch: answer}));
    } catch {
        // IPv6 loopback is absent or the port is taken there; the IPv4 listener still answers `localhost`.
    }
    const aborted = () => reject(timeout.aborted
        ? new Error("Claude sign-in was not completed in the browser within five minutes")
        : deadline.reason instanceof Error ? deadline.reason : new Error("Claude sign-in was cancelled"));
    deadline.addEventListener("abort", aborted, {once: true});
    try {
        const redirect = `http://localhost:${server.port}/callback`;
        const {url} = await flow.generateAuthUrl(state, redirect);
        await openBrowser(url);
        const granted = credential(await flow.exchangeToken(await code, state, redirect));
        await locked(path, () => write(path, granted));
        return status(granted);
    } finally {
        deadline.removeEventListener("abort", aborted);
        for (const listener of servers) void listener.stop(true);
    }
}
