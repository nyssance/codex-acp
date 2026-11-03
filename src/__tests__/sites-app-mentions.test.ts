import { expect, test } from "vitest";
import { toUserInput } from "../alwith/codex/sessionConfig";

test("app references are native mentions; ordinary file links remain text", () => {
    const result = toUserInput([
        { type: "resource_link", name: "Sites", uri: "app://connector_sites" },
        { type: "resource_link", name: "notes", uri: "file:///tmp/notes" },
    ]);
    expect(result[0]).toEqual({ type: "mention", name: "Sites", path: "app://connector_sites" });
    expect(result[1]?.type).toBe("text");
});
