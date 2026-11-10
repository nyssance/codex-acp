import type {EventEmitter} from "node:events";
import type {PassThrough, Writable} from "node:stream";
import {afterEach, expect, it, vi} from "vitest";
import type {CodexConnection} from "../CodexJsonRpcConnection";

type FakeProcess = EventEmitter & {
    stdin: Writable;
    stdout: PassThrough;
    stderr: PassThrough;
    exitCode: number | null;
    signalCode: string | null;
    finish(): void;
    kill(): boolean;
};
const {processes} = vi.hoisted(() => ({processes: [] as FakeProcess[]}));
vi.mock("node:child_process", async () => {
    const {EventEmitter} = await import("node:events");
    const {PassThrough, Writable} = await import("node:stream");
    return {
        spawn: () => {
            const process = new EventEmitter() as FakeProcess;
            process.stdout = new PassThrough();
            process.stderr = new PassThrough();
            process.exitCode = null;
            process.signalCode = null;
            process.finish = () => {
                if (process.exitCode !== null) return;
                process.exitCode = 0;
                process.stdout.end();
                process.stderr.end();
                process.emit("exit", 0, null);
            };
            process.kill = () => {
                process.finish();
                return true;
            };
            process.stdin = new Writable({
                write(chunk: Buffer, _encoding, callback) {
                    for (const line of chunk.toString().trim().split("\n")) {
                        const request = JSON.parse(line) as {
                            id?: number;
                            method?: string;
                        };
                        if (request.id === undefined) continue;
                        const result =
                            request.method === "config/read"
                                ? {config: {model_provider: "openai"}}
                                : request.method === "thread/start"
                                  ? {thread: {id: "gateway-thread"}}
                                  : {};
                        setImmediate(() => {
                            if (!process.stdout.writableEnded) process.stdout.write(JSON.stringify({id: request.id, result}) + "\n");
                        });
                    }
                    callback();
                },
                final(callback) {
                    callback();
                    queueMicrotask(process.finish);
                },
            });
            processes.push(process);
            return process;
        },
    };
});
vi.mock("cross-spawn", async () => ({
    default: (await import("node:child_process")).spawn,
}));
const connections: CodexConnection[] = [];
afterEach(() => {
    for (const connection of connections.splice(0)) connection.connection.dispose();
    for (const process of processes.splice(0)) {
        process.finish();
        process.stdin.destroy();
        process.stdout.destroy();
        process.stderr.destroy();
    }
});
async function gateway(): Promise<{
    connection: CodexConnection;
    completed: string[];
}> {
    const {startCodexConnection} = await import("../CodexJsonRpcConnection");
    const connection = startCodexConnection("/fake", {}, ["app-server"], {
        disposeOnExit: false,
    });
    connections.push(connection);
    await connection.connection.sendRequest("initialize", {});
    await connection.connection.sendRequest("thread/start", {
        modelProvider: "gateway",
    });
    const completed: string[] = [];
    connection.connection.onUnhandledNotification(event => {
        if (event.method === "turn/completed") completed.push("completed");
    });
    return {connection, completed};
}
const finalFrame =
    JSON.stringify({
        method: "turn/completed",
        params: {
            threadId: "gateway-thread",
            turn: {id: "turn-1", status: "completed"},
        },
    }) + "\n";

it("delivers the final gateway completion before invalidating the connection generation", async () => {
    const {connection, completed} = await gateway();
    processes[1]!.stdout.write(finalFrame);
    processes[1]!.finish();
    await connection.drained;
    expect(completed).toEqual(["completed"]);
});

it("drains gateway output when primary exits first", async () => {
    const {connection, completed} = await gateway();
    processes[1]!.stdout.write(finalFrame);
    processes[0]!.finish();
    await connection.drained;
    expect(completed).toEqual(["completed"]);
    expect(processes[1]!.stdin.writableEnded).toBe(true);
});
