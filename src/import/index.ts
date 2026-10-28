import type { MessageConnection } from "vscode-jsonrpc";
import type {
    ExternalAgentConfigDetectParams,
    ExternalAgentConfigDetectResponse,
    ExternalAgentConfigImportParams,
    ExternalAgentConfigImportResponse,
    ExternalAgentConfigImportHistoriesReadResponse,
    ExternalAgentConfigImportProgressNotification,
    ExternalAgentConfigImportCompletedNotification,
} from "../app-server/v2";

export type {
    ExternalAgentConfigDetectParams,
    ExternalAgentConfigDetectResponse,
    ExternalAgentConfigImportParams,
    ExternalAgentConfigImportResponse,
    ExternalAgentConfigImportHistoriesReadResponse,
    ExternalAgentConfigImportProgressNotification,
    ExternalAgentConfigImportCompletedNotification,
    ExternalAgentConfigMigrationItem,
    ExternalAgentConfigImportTypeResult,
} from "../app-server/v2";

export type ImportSource = "claude-code" | "cursor";
export type ImportConnection = Pick<
    MessageConnection,
    "sendRequest" | "onUnhandledNotification" | "onClose" | "onDispose"
>;

/** Uses an initialized app-server connection; never creates a chat or owns the process. */
export class CodexImportClient {
    constructor(private readonly connection: ImportConnection) {}

    detect(
        params: Omit<
            ExternalAgentConfigDetectParams,
            "migrationSource" | "source"
        > & { migrationSource: ImportSource },
    ): Promise<ExternalAgentConfigDetectResponse> {
        return this.connection.sendRequest(
            "externalAgentConfig/detect",
            params,
        );
    }

    /** Acceptance only. Subscribe to completion before sending this request. */
    import(
        params: Omit<ExternalAgentConfigImportParams, "migrationSource"> & {
            migrationSource: ImportSource;
        },
    ): Promise<ExternalAgentConfigImportResponse> {
        return this.connection.sendRequest(
            "externalAgentConfig/import",
            params,
        );
    }

    /** Wait for the matching completion, including notifications received before acceptance. */
    run(
        params: Parameters<CodexImportClient["import"]>[0],
        onProgress: (
            event: ExternalAgentConfigImportProgressNotification,
        ) => void,
    ): Promise<ExternalAgentConfigImportCompletedNotification> {
        return new Promise((resolve, reject) => {
            let importId: string | null = null;
            let finished = false;
            const early: Array<{
                completed: boolean;
                event: ExternalAgentConfigImportProgressNotification;
            }> = [];
            const stops: Array<{ dispose(): void }> = [];
            const clean = () => {
                finished = true;
                for (const stop of stops) stop.dispose();
                early.length = 0;
            };
            const fail = (error: unknown) => {
                if (!finished) {
                    clean();
                    reject(error);
                }
            };
            const receive = (
                completed: boolean,
                event: ExternalAgentConfigImportProgressNotification,
            ) => {
                if (finished) return;
                if (importId === null) {
                    early.push({ completed, event });
                    return;
                }
                if (event.importId !== importId) return;
                if (completed) {
                    clean();
                    resolve(event);
                } else {
                    try {
                        onProgress(event);
                    } catch (error) {
                        fail(error);
                    }
                }
            };
            stops.push(
                this.onProgress((event) => receive(false, event)),
                this.onCompleted((event) => receive(true, event)),
            );
            const disconnected = () =>
                fail(
                    new Error(
                        "Codex disconnected during import; check import history after reconnecting",
                    ),
                );
            stops.push(
                this.connection.onClose(disconnected),
                this.connection.onDispose(disconnected),
            );
            void this.import(params).then((accepted) => {
                if (finished) return;
                importId = accepted.importId;
                for (const item of early.splice(0))
                    receive(item.completed, item.event);
            }, fail);
        });
    }

    readHistories(): Promise<ExternalAgentConfigImportHistoriesReadResponse> {
        return this.connection.sendRequest(
            "externalAgentConfig/import/readHistories",
        );
    }

    onProgress(
        listener: (
            event: ExternalAgentConfigImportProgressNotification,
        ) => void,
    ) {
        return this.connection.onUnhandledNotification((event) => {
            if (event.method === "externalAgentConfig/import/progress")
                listener(
                    event.params as ExternalAgentConfigImportProgressNotification,
                );
        });
    }

    onCompleted(
        listener: (
            event: ExternalAgentConfigImportCompletedNotification,
        ) => void,
    ) {
        return this.connection.onUnhandledNotification((event) => {
            if (event.method === "externalAgentConfig/import/completed")
                listener(
                    event.params as ExternalAgentConfigImportCompletedNotification,
                );
        });
    }
}
