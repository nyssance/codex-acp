import { Cause, Effect, Exit } from "effect";

export function attempt<A>(work: () => Promise<A>): Effect.Effect<A, unknown> {
    return Effect.tryPromise({ try: work, catch: (error) => error });
}

export function failure(cause: Cause.Cause<unknown>): unknown {
    const errors = cause.reasons.flatMap((reason) => {
        if (Cause.isFailReason(reason)) return [reason.error];
        if (Cause.isDieReason(reason)) return [reason.defect];
        return [];
    });
    if (errors.length === 1) return errors[0];
    if (errors.length === 0) return Cause.squash(cause);
    return new AggregateError(errors, "Lifecycle operation and cleanup failed");
}

export async function run<A>(effect: Effect.Effect<A, unknown>): Promise<A> {
    const exit = await Effect.runPromiseExit(effect);
    if (Exit.isFailure(exit)) throw failure(exit.cause);
    return exit.value;
}
