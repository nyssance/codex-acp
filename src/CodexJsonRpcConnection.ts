import * as rpc from "vscode-jsonrpc/node";
import type {Message} from "vscode-jsonrpc/node";
import type {MessageConnection} from "vscode-jsonrpc/node";
import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {createRequire} from "node:module";
import crossSpawn from "cross-spawn";

import { createJSONRPCReader, createJSONRPCWriter } from "./StdUtils";
import { logger } from "./Logger";
import { providerConnections } from "./ProviderConnections";

const require = createRequire(import.meta.url);

export interface CodexConnection {
    readonly connection: MessageConnection
    readonly process: ChildProcessWithoutNullStreams;
    /**
     * Settles once the connection has handled every message that the process wrote before its stdout ended.
     * `CodexAppServerSupervisor` waits for it before it disposes the connection of a dead process.
     */
    readonly drained?: Promise<void>;
}

/** A notification that the adapter feeds into the connection after the last message of the process. */
const DRAINED_MARKER_METHOD = "codex-acp/stdoutDrained";

export interface StartCodexConnectionOptions {
    /**
     * Dispose the connection when the process exits (default). `CodexAppServerSupervisor` turns it off: it disposes
     * the connection itself, after the last output of the process was read.
     */
    disposeOnExit?: boolean;
}

export function startCodexConnection(
    codexPath?: string,
    env?: NodeJS.ProcessEnv,
    appServerStartupArgs: string[] = ["app-server"],
    options: StartCodexConnectionOptions = {},
): CodexConnection {
    const primary = startRawCodexConnection(
        codexPath,
        env,
        appServerStartupArgs,
        { disposeOnExit: false },
    );
    const children = new Map<
        NativeConnection,
        (unexpected: boolean) => Promise<void>
    >();
    let closing = false;
    primary.connection.onDispose(() => {
        closing = true;
        for (const child of children.keys()) child.connection.dispose();
    });
    const connection = providerConnections(
        primary.connection,
        (provider, catalog, defined) => {
            // Only the provider identity is process-wide. Credentials and endpoints stay in thread config.
            const args = [
                ...appServerStartupArgs,
                "-c",
                `model_provider=${JSON.stringify(provider)}`,
            ];
            if (provider !== "openai" && defined)
                args.push(
                    "-c",
                    `model_providers={${JSON.stringify(provider)}={name=${JSON.stringify(provider)},base_url="http://127.0.0.1",wire_api="responses",requires_openai_auth=false}}`,
                );
            if (catalog !== undefined)
                args.push(
                    "-c",
                    `model_catalog_json=${JSON.stringify(catalog)}`,
                );
            const child = startRawCodexConnection(codexPath, env, args, {
                disposeOnExit: false,
            });
            let intentional = false;
            let finalizing: Promise<void> | undefined;
            const finish = (unexpected: boolean): Promise<void> => {
                finalizing ??= waitForNativeOutput(child).then(() => {
                    children.delete(child);
                    child.connection.dispose();
                    // Deliver the final child frames before the primary exit triggers upstream recovery.
                    if (unexpected && !closing) primary.process.stdin.end();
                });
                if (!unexpected) requestNativeStop(child);
                return finalizing;
            };
            children.set(child, finish);
            child.connection.onDispose(() => {
                intentional = true;
                children.delete(child);
                requestNativeStop(child);
            });
            child.process.once("error", (error) => {
                logger.error("Provider app-server failed", error);
                if (!intentional) void finish(!closing);
            });
            child.process.stdout.once("end", () => {
                if (!intentional) void finish(!closing);
            });
            child.process.once("exit", () => {
                if (!intentional) void finish(!closing);
            });
            return child.connection;
        },
    );
    const drained = primary.drained.then(async () => {
        closing = true;
        await Promise.all(
            [...children.values()].map((finish) => finish(false)),
        );
    });
    if (options.disposeOnExit ?? true)
        primary.process.once("exit", () => {
            void drained.then(() => connection.dispose());
        });
    return { ...primary, connection, drained };
}

type NativeConnection = CodexConnection & { drained: Promise<void> };

function requestNativeStop(child: NativeConnection): void {
    if (
        child.process.exitCode !== null ||
        child.process.signalCode !== null ||
        child.process.stdin.writableEnded
    )
        return;
    child.process.stdin.end();
    const timer = setTimeout(() => child.process.kill("SIGTERM"), 2_000);
    timer.unref();
    child.process.once("exit", () => clearTimeout(timer));
}

/** Like the upstream supervisor, bound inherited stdout pipes, but never truncate a queue after EOF. */
function waitForNativeOutput(child: NativeConnection): Promise<void> {
    return new Promise((resolve) => {
        let grace: ReturnType<typeof setTimeout> | undefined;
        const ended = () => clearTimeout(grace);
        const settle = () => {
            clearTimeout(grace);
            child.process.stdout.off("end", ended);
            disposed.dispose();
            resolve();
        };
        const disposed = child.connection.onDispose(settle);
        if (!child.process.stdout.readableEnded) {
            child.process.stdout.once("end", ended);
            grace = setTimeout(settle, 2_000);
            grace.unref();
        }
        void child.drained.then(settle);
    });
}

function startRawCodexConnection(
    codexPath: string | undefined,
    env: NodeJS.ProcessEnv | undefined,
    appServerStartupArgs: string[],
    options: StartCodexConnectionOptions,
): NativeConnection {
    const spawnEnv = env ?? process.env;
    const startupArgs = [
        ...appServerStartupArgs,
        "--enable",
        "external_agent_memory_import",
    ];

    let codex: ChildProcessWithoutNullStreams;
    if (codexPath) {
        // cross-spawn runs `.cmd` shims through cmd.exe with correct escaping for the TOML hook override.
        codex =
            process.platform === "win32"
                ? (crossSpawn(codexPath, startupArgs, {
                      env: spawnEnv,
                  }) as ChildProcessWithoutNullStreams)
                : spawn(codexPath, startupArgs, { env: spawnEnv });
    } else {
        const bundledCodexPath = require.resolve("@openai/codex/bin/codex.js");
        codex = spawn(process.execPath, [bundledCodexPath, ...startupArgs], {
            env: spawnEnv,
        });
    }

    attachLogs(codex);
    // A write to a process that is dying fails with EPIPE. Without a listener that error would end the adapter.
    codex.stdin.on("error", (error) => logger.log(`[STDIN ERROR] ${error.message}`));
    codex.stdout.on("error", (error) => logger.log(`[STDOUT ERROR] ${error.message}`));

    const reader = createJSONRPCReader(codex.stdout);
    const writer = createJSONRPCWriter(codex.stdin);

    const connection = rpc.createMessageConnection(reader, writer);

    connection.listen();

    // vscode-jsonrpc handles the messages that it read one by one, after the read. The marker comes after the last
    // message of the process, so its handler runs only when every earlier message was handled.
    const drained = new Promise<void>(resolve => {
        connection.onNotification(DRAINED_MARKER_METHOD, () => resolve());
    });
    codex.stdout.on("end", () => reader.deliver?.({jsonrpc: "2.0", method: DRAINED_MARKER_METHOD} as Message));

    if (options.disposeOnExit ?? true) {
        // Terminate all current activities on process termination
        codex.on("exit", _ => {
            connection.dispose();
        });
    }

    return { connection, process: codex, drained };
}

/**
 * Logs the traffic of the app-server.
 * The listeners stay attached when logging is off, so that stderr keeps draining,
 * but a chunk is turned into a string only when the logger writes it.
 */
export function attachLogs(proc: ChildProcessWithoutNullStreams) {
    const originalWrite = proc.stdin.write.bind(proc.stdin);
    proc.stdin.write = (chunk: any, encoding?: any, callback?: any): boolean => {
        if (logger.enabled) logger.log(`[IN] ${chunk.toString()}`);
        return originalWrite(chunk, encoding, callback);
    };

    proc.stderr.on("data", (data) => {
        if (logger.enabled) logger.log(`[ERR] ${data.toString()}`);
    });
    proc.stdout.on("data", (data: Buffer) => {
        if (logger.enabled) logger.log(`[OUT] ${data.toString()}`);
    });
    proc.on("exit", (code) => {
        logger.log(`[EXIT] code: ${code?.toString()}`);
    });
}
