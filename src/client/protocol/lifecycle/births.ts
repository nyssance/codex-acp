/** Bounds notifications arriving before a creation response reveals the session ID. */
export class SessionBirths<Update> {
    private epoch = {};
    private creating = 0;
    private size = 0;
    private overflow: Error | null = null;
    private frames: { sessionId: string; update: Update }[] = [];

    constructor(private readonly capacity = 4096) {
        if (!Number.isSafeInteger(capacity) || capacity < 1)
            throw new RangeError("Birth buffer capacity must be positive");
    }

    buffer(sessionId: string, update: Update): boolean {
        if (this.creating === 0) return false;
        if (this.size >= this.capacity) {
            this.overflow = new Error(
                "Session creation event buffer capacity exceeded",
            );
            throw this.overflow;
        }
        this.frames.push({ sessionId, update });
        this.size++;
        return true;
    }

    clear(): void {
        this.epoch = {};
        this.overflow = null;
        this.creating = 0;
        this.frames = [];
        this.size = 0;
    }

    private assertCapacity(): void {
        if (this.overflow) throw this.overflow;
    }

    async run<Response extends { sessionId: string }>(
        request: () => Promise<Response>,
        settle: (response: Response) => void,
        accept: (sessionId: string, update: Update) => void,
        known?: (sessionId: string) => boolean,
    ): Promise<Response> {
        this.assertCapacity();
        if (this.creating >= 256)
            throw new Error("Session creation capacity exceeded");
        const epoch = this.epoch;
        this.creating++;
        try {
            const response = await request();
            if (epoch !== this.epoch)
                throw new Error(
                    "Session creation belongs to a retired connection",
                );
            this.assertCapacity();
            settle(response);
            // Preserve wire order: an announcement makes its following child frames addressable.
            const queued = this.frames;
            this.frames = [];
            for (const frame of queued) {
                if (
                    frame.sessionId === response.sessionId ||
                    known?.(frame.sessionId)
                ) {
                    this.size--;
                    accept(frame.sessionId, frame.update);
                } else this.frames.push(frame);
            }
            return response;
        } finally {
            if (epoch === this.epoch) {
                this.creating--;
                if (this.creating === 0) {
                    this.frames = [];
                    this.size = 0;
                    this.overflow = null;
                }
            }
        }
    }
}
