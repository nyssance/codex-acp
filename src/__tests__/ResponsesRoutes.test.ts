import { afterEach, expect, it, vi } from "vitest";
import { ResponsesRoutes } from "../alwith/codex/responsesRoutes";
import { ResponsesProxy } from "../alwith/codex/responsesProxy";

afterEach(() => vi.restoreAllMocks());
it("reuses workspace routes and replaces their readers after app-server recovery without eager authentication", async () => {
    const route = vi
        .spyOn(ResponsesProxy.prototype, "route")
        .mockResolvedValue("http://127.0.0.1/route");
    vi.spyOn(ResponsesProxy.prototype, "close").mockImplementation(() => {});
    const routes = new ResponsesRoutes();
    const context = (base: string) => ({
        cwd: "/workspace",
        readConfig: vi.fn(async () => ({ config: { openai_base_url: base } })),
        readAccount: vi.fn(async () => ({
            account: null,
            requiresOpenaiAuth: false,
            workspaceRouting: null,
        })),
    });
    const old = context("https://old.example/v1");
    const fresh = context("https://fresh.example/v1");
    await routes.config({}, "openai", old);
    await routes.config({}, "openai", fresh);
    expect(old.readConfig).not.toHaveBeenCalled();
    expect(fresh.readConfig).not.toHaveBeenCalled();
    expect(route.mock.calls[0]![0]).toBe(route.mock.calls[1]![0]);
    const resolve = route.mock.calls[0]![0] as () => Promise<string>;
    expect(await resolve()).toBe("https://fresh.example/v1");
    expect(old.readConfig).not.toHaveBeenCalled();
    expect(fresh.readAccount).not.toHaveBeenCalled();
    routes.close();
});

it("routes external endpoints through compatibility without changing credentials or another provider", async () => {
    const route = vi
        .spyOn(ResponsesProxy.prototype, "route")
        .mockResolvedValue("http://127.0.0.1/external");
    vi.spyOn(ResponsesProxy.prototype, "close").mockImplementation(() => {});
    const routes = new ResponsesRoutes();
    const config = {
        model_providers: {
            kimi: {
                name: "KIMI",
                base_url: "https://api.example/v1",
                experimental_bearer_token: "private-test-secret",
            },
            other: { name: "Other", base_url: "https://other.example/v1" },
        },
    };
    const context = {
        cwd: "/workspace",
        readConfig: vi.fn(),
        readAccount: vi.fn(),
    };
    const output = await routes.config(config, "kimi", context);
    expect(route).toHaveBeenCalledExactlyOnceWith("https://api.example/v1");
    expect(output).toEqual({
        model_providers: {
            ...config.model_providers,
            kimi: {
                ...config.model_providers.kimi,
                base_url: "http://127.0.0.1/external",
            },
        },
    });
    expect(config.model_providers.kimi.base_url).toBe("https://api.example/v1");
    expect(context.readAccount).not.toHaveBeenCalled();
    routes.close();
});
