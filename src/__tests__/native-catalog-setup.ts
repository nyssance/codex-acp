import {vi} from "vitest";

// Unit suites use in-process native fakes. Explicit integration runs inspect the real binary.
if (process.env["RUN_APP_SERVER_TESTS"] !== "1") {
    vi.doMock("../alwith/codex/bundledModels", () => ({
        bundledModels: () => [],
    }));
}
