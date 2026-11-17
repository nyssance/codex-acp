import type {CodexAppServerClient} from "./CodexAppServerClient";
import {isThreadNotFoundError, isThreadNotLoadedError} from "./CodexThreadErrors";

import type {BackgroundTerminal, BackgroundTerminalStopResult} from "./BackgroundTerminalTypes";

export async function listBackgroundTerminals(client: CodexAppServerClient, sessionId: string): Promise<BackgroundTerminal[]> {
    const terminals: BackgroundTerminal[] = [];
    try {
        for await (const page of client.backgroundTerminalPages(sessionId)) {
            terminals.push(...page.map(({itemId, processId, command}) => ({itemId, processId, command})));
        }
    } catch (error) {
        if (!isThreadNotFoundError(error) && !isThreadNotLoadedError(error)) throw error;
    }
    return terminals;
}

/** Snapshot all pages first. A later process is outside this operation's target set. */
export async function stopBackgroundTerminals(client: CodexAppServerClient, sessionId: string, verifyAll = true): Promise<BackgroundTerminalStopResult> {
    const targets = await listBackgroundTerminals(client, sessionId);
    const result: BackgroundTerminalStopResult = {stopped: [], failures: []};
    for (const terminal of targets) {
        try {
            const response = await client.threadBackgroundTerminalsTerminate({threadId: sessionId, processId: terminal.processId});
            if (verifyAll || !response.terminated) {
                const remaining = await listBackgroundTerminals(client, sessionId);
                if (remaining.some(current => current.processId === terminal.processId)) throw new Error(`Codex could not stop background terminal ${terminal.processId}`);
            }
            result.stopped.push(terminal.processId);
        } catch (error) {
            if (isThreadNotFoundError(error) || isThreadNotLoadedError(error)) result.stopped.push(terminal.processId);
            else result.failures.push({processId: terminal.processId, message: error instanceof Error ? error.message : String(error)});
        }
    }
    return result;
}
