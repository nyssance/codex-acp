import { SessionAdmission } from "./admission";

/** Serializes preparation and fences cancelled work before the first prompt byte. */
export class PromptAdmission {
    private generation = 0;
    private readonly preparation = new SessionAdmission();
    private closed = false;

    cancel(): void {
        this.generation++;
    }
    close(): void {
        this.closed = true;
        this.cancel();
    }

    checkpoint(): () => void {
        const generation = this.generation;
        return () => {
            if (this.closed || generation !== this.generation)
                throw new DOMException(
                    "Session operation retired",
                    "AbortError",
                );
        };
    }

    async run<T>(
        prepare: (assertCurrent: () => void) => void | Promise<void>,
        send: () => Promise<T>,
        schedule: (
            operation: () => Promise<{ response: Promise<T> }>,
        ) => Promise<{ response: Promise<T> }> = (operation) => operation(),
    ): Promise<T> {
        if (this.closed) throw new Error("Session client is closed");
        const generation = this.generation;
        const assertCurrent = () => {
            if (this.closed || generation !== this.generation)
                throw new DOMException(
                    "Prompt cancelled before admission",
                    "AbortError",
                );
        };
        const ready = this.preparation.enqueue("preparation", () =>
            schedule(async () => {
                assertCurrent();
                const prepared = prepare(assertCurrent);
                if (prepared !== undefined) await prepared;
                assertCurrent();
                return { response: send() };
            }),
        );
        // Only preparation is serialized; follow-up prompts can arrive during generation.
        const { response } = await ready;
        return await response;
    }
}
