import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { RequestError } from "@agentclientprotocol/sdk/unstable";
import type { CodexAppServerClient } from "../CodexAppServerClient";
import type {
    Project,
    ProjectCreateResponse,
    ProjectListResponse,
    ProjectReadResponse,
} from "../app-server/v2";
import {
    matchingProject,
    normalizedPath,
    type ProjectContext,
} from "./projection";

export interface ProjectPort {
    request<T>(method: string, params: unknown): Promise<T>;
}

/** Codex owns project IDs and persistence. This class only serializes concurrent registrations. */
export class CodexProjects {
    private readonly registrations = new Map<string, Promise<string>>();
    constructor(
        private readonly port: ProjectPort,
        private readonly home = homedir(),
    ) {}

    async list(): Promise<Project[]> {
        const projects: Project[] = [];
        const seen = new Set<string>();
        let cursor: string | null = null;
        do {
            const page: ProjectListResponse = await this.port.request(
                "project/list",
                { cursor, limit: 100 },
            );
            if (!page || !Array.isArray(page.data))
                throw new Error("Codex project/list is unavailable or invalid");
            projects.push(...page.data);
            cursor = page.nextCursor;
            if (cursor !== null) {
                if (typeof cursor !== "string" || seen.has(cursor))
                    throw new Error(
                        "Codex project/list repeated or returned an invalid cursor",
                    );
                seen.add(cursor);
            }
        } while (cursor !== null);
        return projects;
    }

    async context(createChatDirectory = false): Promise<ProjectContext> {
        const chatDirectory = join(this.home, "Documents", "ALwith");
        if (createChatDirectory)
            await mkdir(chatDirectory, { recursive: true });
        return {
            homeDirectory: this.home,
            codexChatDirectory: join(this.home, "Documents", "Codex"),
            chatDirectory,
            projects: await this.list(),
        };
    }

    async resolve(cwd: string, metadata: unknown): Promise<string | null> {
        const carrier = metadata as
            { codex?: { projectId?: unknown } } | null | undefined;
        const requested = carrier?.codex?.projectId;
        if (requested === null) return null;
        if (requested !== undefined) {
            if (typeof requested !== "string" || !requested)
                throw RequestError.invalidParams(
                    undefined,
                    "Expected codex.projectId to be a nonempty string or null",
                );
            const response = await this.port.request<ProjectReadResponse>(
                "project/read",
                { projectId: requested },
            );
            if (response.project.id !== requested)
                throw new Error("Codex returned a different project");
            return requested;
        }
        cwd = resolve(cwd);
        const key = normalizedPath(cwd);
        const existing = this.registrations.get(key);
        if (existing) return existing;
        const operation = this.register(cwd);
        this.registrations.set(key, operation);
        try {
            return await operation;
        } finally {
            this.registrations.delete(key);
        }
    }

    private async register(cwd: string): Promise<string> {
        const existing = matchingProject(await this.list(), cwd);
        if (existing) return existing.id;
        const name =
            cwd.replaceAll("\\", "/").replace(/\/+$/, "").split("/").pop() ||
            cwd;
        const { project } = await this.port.request<ProjectCreateResponse>(
            "project/create",
            {
                name,
                roots: [{ path: cwd }],
                idempotencyKey: crypto.randomUUID(),
            },
        );
        if (typeof project?.id !== "string" || !project.id)
            throw new Error("Codex project/create did not return a project ID");
        return project.id;
    }
}

const registries = new WeakMap<CodexAppServerClient, CodexProjects>();
export function projectsFor(client: CodexAppServerClient): CodexProjects {
    let registry = registries.get(client);
    if (!registry) {
        registry = new CodexProjects({
            request: (method, params) =>
                client.connection.sendRequest(method, params),
        });
        registries.set(client, registry);
    }
    return registry;
}
