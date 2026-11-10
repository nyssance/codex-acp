import {PassThrough} from "node:stream";
import {createMessageConnection, StreamMessageReader, StreamMessageWriter} from "vscode-jsonrpc/node";
import {afterEach, expect, it, vi} from "vitest";
import {CodexImportClient} from "../import";

const disposables: {dispose(): void}[] = [];
afterEach(() => {
    for (const disposable of disposables.splice(0)) disposable.dispose();
});

function setup() {
    const outgoing = new PassThrough();
    const incoming = new PassThrough();
    const client = createMessageConnection(new StreamMessageReader(incoming), new StreamMessageWriter(outgoing));
    const server = createMessageConnection(new StreamMessageReader(outgoing), new StreamMessageWriter(incoming));
    disposables.push(client, server);
    client.listen();
    server.listen();
    return {
        client: new CodexImportClient(client),
        server,
        connection: client,
    };
}

it("delivers early completion and progress independently of acceptance, retaining partial failures", async () => {
    const {client, server} = setup();
    const received: unknown[] = [];
    const failure = {
        importId: "import-1",
        itemTypeResults: [
            {
                itemType: "MEMORY",
                successes: [],
                failures: [
                    {
                        itemType: "MEMORY",
                        errorType: null,
                        subErrorType: null,
                        failureStage: "copy",
                        message: "denied",
                        cwd: null,
                        source: null,
                    },
                ],
            },
        ],
    };
    disposables.push(client.onProgress(event => received.push(["progress", event])));
    disposables.push(client.onCompleted(event => received.push(["completed", event])));
    server.onRequest("externalAgentConfig/import", async params => {
        expect(params.migrationSource).toBe("claude-code");
        await server.sendNotification("externalAgentConfig/import/progress", failure);
        await server.sendNotification("externalAgentConfig/import/completed", failure);
        return {importId: "import-1"};
    });
    expect(
        await client.import({
            migrationSource: "claude-code",
            migrationItems: [],
        }),
    ).toEqual({importId: "import-1"});
    expect(received).toEqual([
        ["progress", failure],
        ["completed", failure],
    ]);
});

it("removes only the disposed subscription", async () => {
    const {client, server} = setup();
    const received: unknown[] = [];
    const removed = client.onCompleted(() => {
        throw new Error("Disposed listener called");
    });
    disposables.push(client.onCompleted(event => received.push(event)));
    removed.dispose();
    await server.sendNotification("externalAgentConfig/import/completed", {
        importId: "other",
        itemTypeResults: [],
    });
    await vi.waitFor(() => expect(received).toEqual([{importId: "other", itemTypeResults: []}]));
});

it("run correlates early notifications and ignores another import", async () => {
    const {client, server} = setup();
    const progress: unknown[] = [];
    server.onRequest("externalAgentConfig/import", async () => {
        await server.sendNotification("externalAgentConfig/import/completed", {
            importId: "other",
            itemTypeResults: [],
        });
        await server.sendNotification("externalAgentConfig/import/progress", {
            importId: "ours",
            itemTypeResults: [],
        });
        await server.sendNotification("externalAgentConfig/import/completed", {
            importId: "ours",
            itemTypeResults: [],
        });
        return {importId: "ours"};
    });
    expect(await client.run({migrationSource: "claude-code", migrationItems: []}, event => progress.push(event))).toEqual({
        importId: "ours",
        itemTypeResults: [],
    });
    expect(progress).toEqual([{importId: "ours", itemTypeResults: []}]);
});

it("run rejects when the transport disappears after acceptance", async () => {
    const {client, server, connection} = setup();
    server.onRequest("externalAgentConfig/import", () => ({
        importId: "pending",
    }));
    const result = client.run({migrationSource: "cursor", migrationItems: []}, () => {});
    const rejected = expect(result).rejects.toThrow("Codex disconnected");
    connection.dispose();
    await rejected;
});
