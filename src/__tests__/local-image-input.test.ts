import {pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {expect, it} from "vitest";
import {buildPromptItems} from "../CodexAcpClient";

it("uses the native path for opted-in local image attachments and keeps existing image inputs", () => {
    const path = resolve("image #1 测试.png");
    const preview = {type: "image" as const, mimeType: "image/png", data: "AQ=="};
    const uri = pathToFileURL(path).href;
    expect(buildPromptItems([
        {...preview, uri, _meta: {"alwith.localImage": true}},
        {...preview, uri},
        {...preview, uri: "https://example.com/image.png"},
    ])).toEqual([
        {type: "localImage", path},
        {type: "image", url: "data:image/png;base64,AQ=="},
        {type: "image", url: "https://example.com/image.png"},
    ]);
});

it.each([undefined, "https://example.com/image.png", "file:relative.png"])(
    "rejects a local image without an absolute file URL (%s)",
    uri => {
        expect(() => buildPromptItems([
            {type: "image", mimeType: "image/png", data: "AQ==", uri, _meta: {"alwith.localImage": true}},
        ])).toThrow("Local image requires an absolute file URL");
    },
);
