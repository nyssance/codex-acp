import {describe, expect, it, vi} from "vitest";
import {parseInputConfig, readSessionInputConfig, writeSessionInputConfig} from "../alwith/codex/sessionInputConfig";
import type {AppServerClient} from "../alwith/codex/AppServerClient";
import type {ThreadAttachment, ThreadAttachmentAddParams, ThreadAttachmentAddResponse, ThreadAttachmentListResponse} from "../app-server/v2";

const inputConfig = {mode: "image" as const, config: {model: "wham", size: "auto"}};
function fixture() {
    const attachments = new Map<string, ThreadAttachment[]>();
    const request = vi.fn(async (method: string, raw: unknown): Promise<ThreadAttachmentAddResponse | ThreadAttachmentListResponse> => {
        const params = raw as ThreadAttachmentAddParams;
        const rows = attachments.get(params.threadId) ?? [];
        if (method === "thread/attachment/list") return {data: rows, nextCursor: null};
        if (method === "thread/attachment/add") {
            const existing = rows.find(row => row.attachmentType === params.attachmentType && row.identityKey === params.identityKey);
            if (existing) return {outcome: "existing", attachment: existing};
            const attachment = {id: crypto.randomUUID(), ...params, createdAt: 1};
            attachments.set(params.threadId, [...rows, attachment]);
            return {outcome: "created", attachment};
        }
        throw new Error(`Unexpected ${method}`);
    });
    const client = {request, threadRead: vi.fn()} as unknown as AppServerClient;
    return {client, request, attachments};
}

describe("Codex-owned session input configuration", () => {
    it("restores from persisted attachments after dropping every in-memory object", async () => {
        const f = fixture();
        await writeSessionInputConfig(f.client, "image", inputConfig);
        const recreated = {request: f.request} as unknown as AppServerClient;
        expect(await readSessionInputConfig(recreated, "image")).toEqual({sessionId: "image", revision: 1, inputConfig});
        expect(await readSessionInputConfig(recreated, "ordinary")).toEqual({sessionId: "ordinary", revision: 0, inputConfig: null});
    });
    it("updates without deleting the previous value and makes repeated writes idempotent", async () => {
        const f = fixture();
        await writeSessionInputConfig(f.client, "image", inputConfig);
        const selected = {mode: "image", config: {model: "seedream", size: "2K"}};
        expect((await writeSessionInputConfig(f.client, "image", selected)).revision).toBe(2);
        await writeSessionInputConfig(f.client, "image", selected);
        expect(f.attachments.get("image")).toHaveLength(2);
        expect((await readSessionInputConfig(f.client, "image")).inputConfig).toEqual(selected);
    });
    it("resolves competing revision keys without replacing an existing attachment", async () => {
        const f = fixture();
        await Promise.all([
            writeSessionInputConfig(f.client, "image", inputConfig),
            writeSessionInputConfig(f.client, "image", {mode: "image", config: {model: "seedream", size: "2K"}}),
        ]);
        const rows = f.attachments.get("image")!;
        expect(rows.map(row => row.identityKey)).toEqual(["1", "2"]);
        expect(rows[0]!.payload).toEqual(inputConfig);
        expect((await readSessionInputConfig(f.client, "image")).revision).toBe(2);
    });
    it("reads all pages and chooses revisions independently of server ordering", async () => {
        const f = fixture();
        await writeSessionInputConfig(f.client, "image", inputConfig);
        await writeSessionInputConfig(f.client, "image", {mode: "chat", config: {}});
        const rows = f.attachments.get("image")!;
        f.request.mockResolvedValueOnce({data: [rows[1]!], nextCursor: "older"}).mockResolvedValueOnce({data: [rows[0]!], nextCursor: null});
        expect((await readSessionInputConfig(f.client, "image")).inputConfig).toEqual({mode: "chat", config: {}});
    });
    it("does not retry an ambiguous native write failure", async () => {
        const f = fixture();
        f.request.mockResolvedValueOnce({data: [], nextCursor: null}).mockRejectedValueOnce(new Error("disconnected after write"));
        await expect(writeSessionInputConfig(f.client, "image", inputConfig)).rejects.toThrow("disconnected after write");
        expect(f.request).toHaveBeenCalledTimes(2);
    });
    it("allows an unmaterialized loaded draft, but never hides an unknown thread", async () => {
        const f = fixture();
        f.request.mockRejectedValue(Object.assign(new Error("thread not found"), {code: -32602}));
        vi.mocked(f.client.threadRead).mockResolvedValue({thread: {id: "draft"}} as never);
        expect((await readSessionInputConfig(f.client, "draft")).inputConfig).toBeNull();
        vi.mocked(f.client.threadRead).mockRejectedValue(new Error("unknown thread"));
        await expect(readSessionInputConfig(f.client, "deleted")).rejects.toThrow("unknown thread");
    });
});

it("stores future mode JSON without knowing its configuration or tool route", async () => {
    const f = fixture();
    const value = {mode: "future-mode", config: {z: [{enabled: true}, null], a: {count: 3}}};
    await writeSessionInputConfig(f.client, "future", value);
    const reordered = {mode: "future-mode", config: {a: {count: 3}, z: [{enabled: true}, null]}};
    expect((await writeSessionInputConfig(f.client, "future", reordered)).revision).toBe(1);
    expect((await readSessionInputConfig(f.client, "future")).inputConfig).toEqual(value);
});

it("rejects non-JSON configs at the storage boundary", () => {
    expect(() => parseInputConfig({mode: "future-mode", config: {value: Infinity}})).toThrow("JSON values");
    expect(() => parseInputConfig({mode: "future-mode", config: new Date()})).toThrow("JSON values");
});
