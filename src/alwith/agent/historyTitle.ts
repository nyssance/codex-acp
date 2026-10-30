import type { Thread, Turn } from "../../app-server/v2";
import { fromUserMessage, promptTitle } from "../codex/sessionConfig";
/** Title from the thread name, else the first user message, else the preview. */
export function historyTitle(
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
