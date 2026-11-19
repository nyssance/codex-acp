import {expect, it} from "vitest";
import {createAuthenticatedFixture, describeE2E} from "./acp-e2e-test-utils";
import {ModelId} from "../../../ModelId";

const DEFAULT_MODEL_ID = ModelId.create("gpt-6-astra", "low")

describeE2E("Models availability", () => {
    it(`default model is available`, async () => {
        const fixture = await createAuthenticatedFixture();
        try {
            const session = await fixture.createSession();
            const models = session.models?.availableModels?.map(m => m.modelId);
            expect(models).toContain(DEFAULT_MODEL_ID.toString())
        } finally {
            await fixture.dispose();
        }
    });
});
