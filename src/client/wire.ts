/** A response value that must be a JSON object; anything else is a protocol error named by `what`. */
export function wireObject(value: unknown, what: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(what);
    return value as Record<string, unknown>;
}
