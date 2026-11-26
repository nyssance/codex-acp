import {expect, test} from "vitest";
import {buildPromptItems} from "../CodexAcpClient";
import {desktopAttachmentHistory} from "../DesktopAttachmentHistory";

test("app references remain native mentions alongside replayable file attachments", () => {
    const file = {type: "resource_link" as const, name: "notes", uri: "file:///tmp/notes"};
    const result = buildPromptItems([
        {type: "resource_link", name: "Sites", uri: "app://connector_sites"},
        file,
    ]);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({type: "mention", name: "Sites", path: "app://connector_sites"});
    const attachment = result.find(input => input.type === "text");
    if (!attachment) throw new Error("Expected a file attachment envelope");
    expect(desktopAttachmentHistory(attachment.text)).toEqual([file]);
});
