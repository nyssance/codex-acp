import type { Thread, Turn } from "../../app-server/v2";
import { listedSessionTitle } from "../../SessionTitle";
import { fromUserMessage, promptTitle } from "../codex/sessionConfig";
import type { CodexAppServerClient } from "../../CodexAppServerClient";

/**
 * The title of a session in the list and in its history. Native previews can start with a
 * serialized attachment, or cut it halfway through a URI; only those read the first page.
 */
export async function sessionTitle(
    client: Pick<CodexAppServerClient, "threadTurnsList">,
    thread: Thread,
): Promise<string | null> {
    if (
        thread.name?.trim() ||
        !/^(?:\[@|# Files mentioned by the user:|<send_user_message_question_reply>)/.test(
            thread.preview.trimStart(),
        )
    )
        return listedSessionTitle(thread);
    const turns = await client.threadTurnsList({
        threadId: thread.id,
        cursor: null,
        limit: 25,
        itemsView: "full",
        sortDirection: "asc",
    });
    return historyTitle(thread, turns.data);
}
/** Title from the thread name, else the first user message, else the preview. */
function historyTitle(
    thread: Pick<Thread, "name" | "preview">,
    turns: readonly Turn[],
): string | null {
    const explicit = thread.name?.trim();
    if (explicit) return explicit;
    for (const turn of turns) {
        for (const item of turn.items) {
            if (item.type !== "userMessage") continue;
            const title = promptTitle(fromUserMessage(item.content));
            if (title) return title;
        }
    }
    const preview = thread.preview.trim();
    return preview.length > 0 ? firstLine(preview) : null;
}

function firstLine(text: string): string {
    const line =
        text
            .split(/\r?\n/)
            .map((part) => part.trim())
            .find((part) => part.length > 0) ?? text;
    return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}
