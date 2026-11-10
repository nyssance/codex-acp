import type {Thread, Turn} from "../../app-server/v2";
import {listedSessionTitle, normalizeSessionTitle} from "../../SessionTitle";
import {parseAsyncQuestionReply} from "../../CodexAsyncQuestions";
import {desktopAttachmentHistory} from "../../DesktopAttachmentHistory";
import type {CodexAppServerClient} from "../../CodexAppServerClient";
import type {UserInput} from "../../app-server/v2";

/**
 * The title of a session in the list and in its history. Native previews can start with a
 * serialized attachment, or cut it halfway through a URI; only those read the first page.
 */
export async function sessionTitle(client: Pick<CodexAppServerClient, "threadTurnsList">, thread: Thread): Promise<string | null> {
    if (
        thread.name?.trim() ||
        !/^(?:\[@|# Files mentioned by the user:|<send_user_message_question_reply>)/.test(thread.preview.trimStart())
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
function historyTitle(thread: Pick<Thread, "name" | "preview">, turns: readonly Turn[]): string | null {
    const explicit = normalizeSessionTitle(thread.name);
    if (explicit) return explicit;
    for (const turn of turns) {
        for (const item of turn.items) {
            if (item.type !== "userMessage") continue;
            const title = userMessageTitle(item.content);
            if (title) return title;
        }
    }
    return listedSessionTitle(thread);
}

/**
 * What the user wrote, normalized as upstream normalizes a title: the request behind the attachment envelope, the question of a
 * reply envelope, the name of a bare file link, else the text itself; then the first mention.
 */
function userMessageTitle(inputs: readonly UserInput[]): string | null {
    for (const input of inputs) {
        if (input.type !== "text") continue;
        const reply = parseAsyncQuestionReply(input.text);
        if (reply) return normalizeSessionTitle(reply[0]!.question);
        const attachments = desktopAttachmentHistory(input.text);
        if (attachments) {
            for (const block of attachments) if (block.type === "text") return normalizeSessionTitle(block.text);
            for (const block of attachments) if (block.type === "resource_link") return block.name;
            continue;
        }
        const link = fileReference(input.text);
        if (link) return link;
        if (input.text.trim().length > 0) return normalizeSessionTitle(input.text);
    }
    const mention = inputs.find(input => input.type === "mention");
    return mention ? mention.name : null;
}

/** The name of a standalone `[@name](file://…)` link, which upstream writes for a resource link. */
function fileReference(text: string): string | null {
    if (!text.startsWith("[@") || !text.endsWith(")") || /[\r\n]/.test(text)) return null;
    const separator = text.lastIndexOf("](file://");
    if (separator < 3) return null;
    const uri = text.slice(separator + 2, -1);
    try {
        if (new URL(uri).protocol !== "file:" || /\s/.test(uri)) return null;
    } catch {
        return null;
    }
    return text.slice(2, separator);
}
