#!/usr/bin/env bun

import {startCodexConnection} from "./CodexJsonRpcConnection";
import {AcpMcpEndpoint} from "./AcpMcpEndpoint";
import {CodexAcpServer, type CodexProcessState} from "./CodexAcpServer";
import {createJsonStream} from "./StdUtils";
import {isCodexAuthRequest} from "./CodexAuthMethod";
import {providerStartupConfig, CodexAcpClient} from "./CodexAcpClient";
import {CodexAppServerClient} from "./CodexAppServerClient";
import packageJson from "../package.json";
import {logger} from "./Logger";
import {appServerStartup, CodexAppServerSupervisor} from "./app-server-recovery/CodexAppServerSupervisor";
import {runLoginCommand} from "./login";
import {runCodexCli} from "./CodexCli";
import {prepareCodexHookConfig} from "./CodexHookConfig";
import {type AcpTransport, createAcpAgentRouter} from "./AcpAgentRouter";
import type {AcpClientConnection, AcpV2Connection} from "./ACPSessionConnection";

if (process.argv.includes("--version")) {
    console.log(`${packageJson.name} ${packageJson.version}`);
    process.exit(0);
}

if (process.argv[2] === "login") {
    const args = process.argv.slice(3);
    runLoginCommand(args)
        .then((success) => process.exit(success ? 0 : 1))
        .catch((error) => {
            console.error("Login error:", error.message);
            process.exit(1);
        });
} else if (process.argv[2] === "cli") {
    const args = process.argv.slice(3);
    runCodexCli(process.env["CODEX_PATH"], args)
        .then((exitCode) => process.exit(exitCode))
        .catch((error) => {
            console.error("Codex CLI error:", error.message);
            process.exit(1);
        });
} else {
    startAcpServer();
}

function startAcpServer() {
    const codexPath = process.env["CODEX_PATH"];
    const configString = process.env["CODEX_CONFIG"];
    const authRequestString = process.env["DEFAULT_AUTH_REQUEST"];
    const modelProvider = process.env["MODEL_PROVIDER"];
    const config = configString ? JSON.parse(configString) : undefined;
    const hookConfig = prepareCodexHookConfig(config);
    const parsedAuthRequest = authRequestString ? JSON.parse(authRequestString) : undefined;
    const defaultAuthRequest = parsedAuthRequest && isCodexAuthRequest(parsedAuthRequest) ? parsedAuthRequest : undefined;

    logger.log("Startup", {
        name: packageJson.name,
        version: packageJson.version,
        codexPath: codexPath,
        modelProvider: modelProvider ?? null,
        codexConfig: config ?? null,
        authRequest: authRequestString ?? null,
        defaultAuthRequest: defaultAuthRequest ?? null,
    });

    const startupState = {
        appServerStartupArgs: hookConfig.appServerStartupArgs,
        providerStartupConfig: providerStartupConfig(modelProvider ?? null, hookConfig.sessionConfig ?? {}, null),
    };
    const startup = appServerStartup(startupState);
    const mcpEndpoint = new AcpMcpEndpoint();
    const spawn = (path: string | undefined, args: string[], env: Record<string, string>) =>
        startCodexConnection(path, {...process.env, ...mcpEndpoint.env, ...env}, args, {disposeOnExit: false});
    const codexProcessState: CodexProcessState = {
        // The supervisor disposes the connection itself, after the last output of the process was read.
        connection: spawn(codexPath, startup.args, startup.env),
        codexPath,
        config: hookConfig.sessionConfig,
        ...startupState,
        modelProvider,
        stderr: "",
    };
    const supervisor = new CodexAppServerSupervisor(codexProcessState, spawn);
    codexProcessState.supervisor = supervisor;

    process.stdin.on("close", () => {
        // Ends the stdin of the app-server, sends SIGTERM if it is still running 2 s later, and never restarts it.
        supervisor.shutdown();
        void mcpEndpoint.close();
    });

    const acpJsonStream = createJsonStream(process.stdin, process.stdout);

    function createAgent(connection: AcpClientConnection | AcpV2Connection, transport: AcpTransport): CodexAcpServer {
        const appServerClient = new CodexAppServerClient(codexProcessState.connection.connection);
        const codexClient = new CodexAcpClient(appServerClient, hookConfig.sessionConfig, modelProvider);
        codexClient.acpMcpServers = mcpEndpoint.attach(transport.context, transport.signal);
        process.stdin.once("close", () => codexClient.closeTransports());
        return new CodexAcpServer(
            connection,
            codexClient,
            defaultAuthRequest,
            undefined,
            undefined,
            codexProcessState,
        );
    }

    createAcpAgentRouter(createAgent).connect(acpJsonStream);
}
