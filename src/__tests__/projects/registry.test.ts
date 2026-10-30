import { describe, expect, test, vi } from "vitest";
import type { Project } from "../../app-server/v2";
import { CodexProjects, type ProjectPort } from "../../projects/registry";
import { sessionGroup, type ProjectContext } from "../../projects/projection";

const project = (id: string, paths: string[], name = id): Project => ({
    id,
    name,
    roots: paths.map((path) => ({ path })),
    metadata: {},
    position: 0,
    createdAt: 0,
    updatedAt: 0,
    recencyAt: null,
});
function fixture(initial: Project[] = []) {
    let projects = initial;
    const calls: Array<{ method: string; params: any }> = [];
    let sequence = 0;
    const port: ProjectPort = {
        async request<T>(method: string, value: unknown): Promise<T> {
            const params = value as any;
            calls.push({ method, params });
            switch (method) {
                case "project/list":
                    return { data: [...projects], nextCursor: null } as T;
                case "project/read": {
                    const found = projects.find(
                        (project) => project.id === params.projectId,
                    );
                    if (!found) throw new Error("Project not found");
                    return { project: found } as T;
                }
                case "project/create": {
                    const created = project(
                        `server-${++sequence}`,
                        params.roots.map((root: { path: string }) => root.path),
                        params.name,
                    );
                    projects.push(created);
                    return { project: created } as T;
                }
                default:
                    throw new Error(`Unexpected request: ${method}`);
            }
        },
    };
    return {
        registry: new CodexProjects(port, "/remote/home"),
        calls,
        remove: () => {
            projects = [];
        },
    };
}

describe("project registration", () => {
    test("null is an explicit projectless request; a selected ID is validated", async () => {
        const f = fixture([project("chosen", ["/work"])]);
        expect(
            await f.registry.resolve("/work", { codex: { projectId: null } }),
        ).toBeNull();
        expect(f.calls).toEqual([]);
        expect(
            await f.registry.resolve("/elsewhere", {
                codex: { projectId: "chosen" },
            }),
        ).toBe("chosen");
        await expect(
            f.registry.resolve("/work", { codex: { projectId: "missing" } }),
        ).rejects.toThrow("not found");
        await expect(
            f.registry.resolve("/work", { codex: { projectId: 3 } }),
        ).rejects.toThrow();
    });
    test("folder intent reuses the longest registered root with exact path boundaries", async () => {
        const f = fixture([
            project("outer", ["/work"]),
            project("inner", ["/work/a", "/alias"]),
        ]);
        expect(await f.registry.resolve("/work/a/src", undefined)).toBe(
            "inner",
        );
        expect(await f.registry.resolve("/work/abc", undefined)).toBe("outer");
        expect(await f.registry.resolve("/alias/src", undefined)).toBe("inner");
        expect(f.calls.some((call) => call.method === "project/create")).toBe(
            false,
        );
    });
    test("concurrent requests register once; deleting a project permits a fresh registration key", async () => {
        const f = fixture();
        expect(
            await Promise.all([
                f.registry.resolve("/work/a", undefined),
                f.registry.resolve("/work/a/", undefined),
            ]),
        ).toEqual(["server-1", "server-1"]);
        f.remove();
        expect(await f.registry.resolve("/work/a", undefined)).toBe("server-2");
        const creates = f.calls.filter(
            (call) => call.method === "project/create",
        );
        expect(creates).toHaveLength(2);
        expect(creates[0]?.params.idempotencyKey).not.toBe(
            creates[1]?.params.idempotencyKey,
        );
    });
    test("list failure never becomes an empty catalog or creates a project", async () => {
        const request = vi.fn().mockRejectedValue(new Error("unavailable"));
        const registry = new CodexProjects({ request });
        await expect(registry.resolve("/work", undefined)).rejects.toThrow(
            "unavailable",
        );
        expect(request).toHaveBeenCalledTimes(1);
    });
    test("all pages are read and repeated cursors are errors", async () => {
        const request = vi
            .fn()
            .mockResolvedValueOnce({
                data: [project("a", ["/a"])],
                nextCursor: "next",
            })
            .mockResolvedValueOnce({
                data: [project("b", ["/b"])],
                nextCursor: null,
            });
        const registry = new CodexProjects({ request }, "/remote/home");
        expect(
            (await registry.context()).projects.map((project) => project.id),
        ).toEqual(["a", "b"]);
        request.mockResolvedValue({ data: [], nextCursor: "loop" });
        await expect(registry.list()).rejects.toThrow("cursor");
    });
});

const context: ProjectContext = {
    homeDirectory: "/remote/home",
    codexChatDirectory: "/remote/home/Documents/Codex",
    chatDirectory: "/remote/home/Documents/ALwith",
    projects: [
        project(
            "registered",
            ["/work", "/remote/home/Documents/Codex/project"],
            "Named project",
        ),
    ],
};
test.each([
    ["/remote/home", null, "quick-chats"],
    ["/remote/home/", null, "quick-chats"],
    ["/remote/home/Documents/Codex/day/chat", null, "quick-chats"],
    ["/remote/home/Documents/ALwith", null, "quick-chats"],
    [
        "/remote/home/Documents/ALwith/child",
        null,
        "/remote/home/Documents/ALwith/child",
    ],
    ["/remote/home/Documents/Codex/project/src", null, "project:registered"],
    ["/workshop", null, "/workshop"],
    ["/unrelated", "registered", "project:registered"],
])(
    "groups %s using server context and persistent assignment",
    (cwd, projectId, expected) => {
        expect(sessionGroup(context, { cwd: cwd!, projectId }).id).toBe(
            expected,
        );
    },
);
