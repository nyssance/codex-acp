import * as rpc from "vscode-jsonrpc/node";
import type {Message} from "vscode-jsonrpc/node";
import type {MessageConnection} from "vscode-jsonrpc/node";
import {spawn, type ChildProcessWithoutNullStreams} from "node:child_process";
import {createRequire} from "node:module";
import crossSpawn from "cross-spawn";

import {createJSONRPCReader, createJSONRPCWriter} from "./StdUtils";
import {logger} from "./Logger";
import {providerConnections} from "./ProviderConnections";
import {CodexAppServerSupervisor} from "./app-server-recovery/CodexAppServerSupervisor";

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

export function startCodexConnection(codexPath?: string, env?: NodeJS.ProcessEnv, appServerStartupArgs: string[] = ["app-server"], options: StartCodexConnectionOptions = {}): CodexConnection {
    const primary = startRawCodexConnection(codexPath, env, appServerStartupArgs, {disposeOnExit: false});
    const children = new Map<NativeConnection, () => Promise<void>>();
    let closing = false;
    primary.connection.onDispose(() => {
        closing = true;
        for (const child of children.keys()) child.connection.dispose();
    });
    const connection = providerConnections(primary.connection, (provider, catalog, defined) => {
        // Only the provider identity is process-wide. Credentials and endpoints stay in thread config.
        const args = [...appServerStartupArgs, "-c", `model_provider=${JSON.stringify(provider)}`];
        if (provider !== "openai" && defined) args.push("-c", `model_providers={${JSON.stringify(provider)}={name=${JSON.stringify(provider)},base_url="http://127.0.0.1",wire_api="responses",requires_openai_auth=false}}`);
        if (catalog !== undefined) args.push("-c", `model_catalog_json=${JSON.stringify(catalog)}`);
        const child = startRawCodexConnection(codexPath, env, args, {
            disposeOnExit: false,
        });
        // Upstream's supervisor stops the child and reads its last output before disposing the connection.
        const supervisor = new CodexAppServerSupervisor(
            {connection: child, codexPath, appServerStartupArgs: args, stderr: ""},
            () => {
                throw new Error("A provider app-server is never restarted in place");
            },
        );
        children.set(child, async () => {
            await supervisor.stop();
        });
        supervisor.onExit((exit) => {
            children.delete(child);
            // Deliver the final child frames before the primary exit triggers upstream recovery.
            if (!exit.intentional && !closing) primary.process.stdin.end();
        });
        child.connection.onDispose(() => {
            void supervisor.stop();
        });
        return child.connection;
    });
    const drained = primary.drained.then(async () => {
        closing = true;
        await Promise.all([...children.values()].map((stop) => stop()));
    });
    if (options.disposeOnExit ?? true)
        primary.process.once("exit", () => {
            void drained.then(() => connection.dispose());
        });
    return {...primary, connection, drained};
}

type NativeConnection = CodexConnection & {drained: Promise<void>};

function startRawCodexConnection(codexPath: string | undefined, env: NodeJS.ProcessEnv | undefined, appServerStartupArgs: string[], options: StartCodexConnectionOptions): NativeConnection {
    const spawnEnv = env ?? process.env;
    const startupArgs = [
        ...appServerStartupArgs,
        // Provider changes must release every detached writer, including threads created before catalog setup.
        "-c",
        "thread_unload_delay_secs=0",
        "--enable",
        "external_agent_memory_import",
    ];

    let codex: ChildProcessWithoutNullStreams;
    if (codexPath) {
        // cross-spawn runs `.cmd` shims through cmd.exe with correct escaping for the TOML hook override.
        codex =
            process.platform === "win32"
                ? (crossSpawn(codexPath, startupArgs, {env: spawnEnv}) as ChildProcessWithoutNullStreams)
                : spawn(codexPath, startupArgs, {env: spawnEnv});
    } else {
        const bundledCodexPath = require.resolve("@openai/codex/bin/codex.js");
        codex = spawn(process.execPath, [bundledCodexPath, ...startupArgs], {env: spawnEnv});
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

    return {connection: connection, process: codex, drained};
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
