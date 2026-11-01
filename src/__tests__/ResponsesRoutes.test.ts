import { afterEach, expect, it, vi } from "vitest";
import { ResponsesRoutes } from "../alwith/codex/responsesRoutes";
import { ResponsesProxy } from "../alwith/codex/responsesProxy";

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});
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

it("moves a gateway route onto the retained native provider without retaining source credentials", async () => {
    vi.spyOn(ResponsesProxy.prototype, "route").mockResolvedValue(
        "http://127.0.0.1/target",
    );
    const routes = new ResponsesRoutes();
    try {
        const result = await routes.config(
            {
                model_providers: {
                    deepseek: {
                        name: "DeepSeek",
                        base_url: "https://deepseek.example/v1",
                        experimental_bearer_token: "target-key",
                    },
                },
            },
            "deepseek",
            { cwd: "/workspace", readConfig: vi.fn(), readAccount: vi.fn() },
            "litellm",
        );
        expect(result["model_providers"]).toEqual({
            litellm: {
                name: "DeepSeek",
                base_url: "http://127.0.0.1/target",
                experimental_bearer_token: "target-key",
                requires_openai_auth: false,
            },
        });
    } finally {
        routes.close();
    }
});

it("routes a gateway through the reserved openai transport without overriding its definition", async () => {
    const route = vi
        .spyOn(ResponsesProxy.prototype, "route")
        .mockResolvedValue("http://127.0.0.1/gateway");
    const routes = new ResponsesRoutes();
    try {
        const output = await routes.config(
            {
                model_providers: {
                    deepseek: {
                        name: "DeepSeek",
                        base_url: "https://gateway.test/v1",
                        experimental_bearer_token: "target-key",
                    },
                },
            },
            "deepseek",
            { cwd: "/workspace", readConfig: vi.fn(), readAccount: vi.fn() },
            "openai",
        );
        expect(output).toEqual({
            model_providers: {},
            openai_base_url: "http://127.0.0.1/gateway",
        });
        expect(route).toHaveBeenCalledWith("https://gateway.test/v1", {
            authorization: "Bearer target-key",
        });
    } finally {
        routes.close();
    }
});

it("preserves provider environment authentication when a native custom provider uses an openai history", async () => {
    vi.stubEnv("PROVIDER_REVIEW_KEY", "provider-key");
    vi.stubEnv("PROVIDER_REVIEW_ORG", "provider-org");
    const route = vi
        .spyOn(ResponsesProxy.prototype, "route")
        .mockResolvedValue("http://127.0.0.1/provider");
    const routes = new ResponsesRoutes();
    try {
        await routes.config(
            {
                model_providers: {
                    corp: {
                        name: "Corp",
                        base_url: "https://corp.example/v1",
                        env_key: "PROVIDER_REVIEW_KEY",
                        env_http_headers: { "x-org": "PROVIDER_REVIEW_ORG" },
                    },
                },
            },
            "corp",
            { cwd: "/workspace", readConfig: vi.fn(), readAccount: vi.fn() },
            "openai",
        );
        expect(route).toHaveBeenCalledWith("https://corp.example/v1", {
            authorization: "Bearer provider-key",
            "x-org": "provider-org",
        });
    } finally {
        routes.close();
    }
});

it("rejects a missing provider key before opening an upstream route", async () => {
    vi.stubEnv("PROVIDER_REVIEW_KEY", "");
    const route = vi.spyOn(ResponsesProxy.prototype, "route");
    const routes = new ResponsesRoutes();
    try {
        await expect(
            routes.config(
                {
                    model_providers: {
                        corp: {
                            name: "Corp",
                            base_url: "https://corp.example/v1",
                            env_key: "PROVIDER_REVIEW_KEY",
                        },
                    },
                },
                "corp",
                {
                    cwd: "/workspace",
                    readConfig: vi.fn(),
                    readAccount: vi.fn(),
                },
                "openai",
            ),
        ).rejects.toThrow("PROVIDER_REVIEW_KEY");
        expect(route).not.toHaveBeenCalled();
    } finally {
        routes.close();
    }
});
