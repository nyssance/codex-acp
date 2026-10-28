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
    "sendRequest" | "onUnhandledNotification"
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
