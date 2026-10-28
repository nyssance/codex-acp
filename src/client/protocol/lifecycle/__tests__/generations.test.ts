import { expect, test } from "bun:test";

import { SessionGenerations } from "../generations";

test("reopening invalidates old work even when the session and agent IDs are reused", () => {
    const generations = new SessionGenerations();
    const first = generations.capture("s");
    const sibling = generations.capture("other");
    expect(generations.capture("s")).toBe(first);
    generations.retire("s");
    expect(generations.isCurrent(first)).toBe(false);
    expect(generations.isCurrent(sibling)).toBe(true);
    const reopened = generations.capture("s");
    expect(reopened).not.toBe(first);
    generations.clear();
    expect(generations.isCurrent(reopened)).toBe(false);
    expect(generations.isCurrent(sibling)).toBe(false);
});
