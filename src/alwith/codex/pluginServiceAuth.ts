import type {PluginServiceAuth} from "../../client/codex-extensions";
import type {AppServerClient} from "./AppServerClient";

/** The host reuses Codex's login without opening or maintaining a credential store. */
export async function readPluginServiceAuth(codex: AppServerClient, refreshToken: boolean, signal?: AbortSignal): Promise<PluginServiceAuth | null> {
    signal?.throwIfAborted();
    const account = await codex.accountRead({refreshToken: false});
    if (account.account?.type !== "chatgpt") return null;
    const routing = account.workspaceRouting;
    if (!routing) throw new Error("ChatGPT workspace routing is unavailable");
    const auth = await codex.getAuthStatus({includeToken: true, refreshToken});
    signal?.throwIfAborted();
    if ((auth.authMethod !== "chatgpt" && auth.authMethod !== "chatgptAuthTokens") || !auth.authToken)
        throw new Error("ChatGPT credentials are unavailable; sign in again");
    const current = await codex.accountRead({refreshToken: false});
    signal?.throwIfAborted();
    if (current.account?.type !== "chatgpt" || current.workspaceRouting?.chatgptAccountId !== routing.chatgptAccountId || current.workspaceRouting.backendOrigin !== routing.backendOrigin)
        throw new Error("ChatGPT account changed while reading plugin credentials");
    return {backendOrigin: routing.backendOrigin, accountId: routing.chatgptAccountId, accessToken: auth.authToken};
}
