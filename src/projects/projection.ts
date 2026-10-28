import type { Project } from "../app-server/v2/Project";

export type ProjectContext = {
    homeDirectory: string;
    codexChatDirectory: string;
    chatDirectory: string;
    projects: Project[];
};

export function normalizedPath(value: string): string {
    const path = value.replaceAll("\\", "/").replace(/^\/\/\?\/UNC\//i, "//").replace(/^\/\/\?\//, "");
    const normalized = path.replace(/\/+$/, "") || "/";
    return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//") ? normalized.toLowerCase() : normalized;
}

export function pathContains(root: string, path: string): boolean {
    const parent = normalizedPath(root);
    const child = normalizedPath(path);
    return parent === child || child.startsWith(parent === "/" ? "/" : parent + "/");
}

export function matchingProject(projects: readonly Project[], cwd: string): Project | undefined {
    return projects.flatMap(project => project.roots.map(root => ({ project, root: root.path })))
        .filter(({ root }) => pathContains(root, cwd))
        .sort((a, b) => normalizedPath(b.root).length - normalizedPath(a.root).length || a.project.id.localeCompare(b.project.id))[0]?.project;
}

export const QUICK_CHATS_GROUP = "quick-chats";
export type SessionGroup = { id: string; name: string; cwd: string | null };

/** Display projection only. Inferred grouping never becomes a persisted project assignment. */
export function sessionGroup(context: ProjectContext, row: { cwd: string; projectId?: string | null }): SessionGroup {
    const project = row.projectId ? context.projects.find(project => project.id === row.projectId) : matchingProject(context.projects, row.cwd);
    if (project) return { id: `project:${project.id}`, name: project.name, cwd: project.roots[0]?.path ?? row.cwd };
    if (row.projectId) return { id: `project:${row.projectId}`, name: row.projectId, cwd: row.cwd };
    const cwd = normalizedPath(row.cwd);
    if (cwd === normalizedPath(context.homeDirectory) || pathContains(context.codexChatDirectory, cwd) || cwd === normalizedPath(context.chatDirectory))
        return { id: QUICK_CHATS_GROUP, name: "", cwd: null };
    return { id: row.cwd, name: row.cwd.replaceAll("\\", "/").replace(/\/+$/, "").split("/").pop() || row.cwd, cwd: row.cwd };
}

export function groupSessions<T extends { cwd: string; projectId?: string | null; updatedAt?: string | null }>(rows: readonly T[], context: ProjectContext): Array<[string, T[]]> {
    const groups = new Map<string, T[]>([[QUICK_CHATS_GROUP, []]]);
    for (const row of [...rows].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))) {
        const id = sessionGroup(context, row).id;
        const group = groups.get(id);
        if (group) group.push(row);
        else groups.set(id, [row]);
    }
    return [...groups];
}

export function projectName(id: string, context?: ProjectContext): string {
    if (id.startsWith("project:")) return context?.projects.find(project => `project:${project.id}` === id)?.name ?? id.slice(8);
    return id.replaceAll("\\", "/").replace(/\/+$/, "").split("/").pop() || id;
}

export function isQuickChatDirectory(cwd: string, context: ProjectContext): boolean {
    return sessionGroup(context, { cwd }).id === QUICK_CHATS_GROUP;
}
