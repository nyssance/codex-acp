import { expect, test } from "vitest";
import { buildPromptItems } from "../CodexAcpClient";

test("app references are native mentions; ordinary file links remain text", () => {
    const result = buildPromptItems([
        { type: "resource_link", name: "Sites", uri: "app://connector_sites" },
        { type: "resource_link", name: "notes", uri: "file:///tmp/notes" },
    ]);
    expect(result[0]).toEqual({ type: "mention", name: "Sites", path: "app://connector_sites" });
    expect(result[1]?.type).toBe("text");
});
