import type * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";
import {afterEach, expect, test} from "vitest";
import {CodexClient} from "../../client/CodexClient";
import {createFakeAgent} from "../../client/protocol/client/__tests__/fake-agent";
import {FakeHubPort} from "../../client/protocol/client/__tests__/fake-runtime-client";

const fast: acp.SessionConfigOption = {configId: "fast-mode", category: "model_config", name: "Fast", type: "boolean", currentValue: true};

const clients: CodexClient[] = [];
afterEach(() => {
    for (const client of clients.splice(0)) client.disconnect();
});

async function make() {
    const fake = createFakeAgent();
    fake.sessionOptions.current = () => [{...fast}];
    const client = new CodexClient(() => Promise.resolve(new FakeHubPort(() => fake.app)), {agentId: "agent", launch: {engine: "codex"}});
    clients.push(client);
    await client.connect();
    return {client, fake};
}

test("a new session starts at standard speed unless the caller chooses Fast", async () => {
    const {client, fake} = await make();
    await client.newSession("/work", {configOptions: [{configId: "model", type: "id", value: "other-model"}]});
    expect(fake.created[0]?.configOptions).toEqual([
        {configId: "model", type: "id", value: "other-model"},
        {configId: "fast-mode", type: "boolean", value: false},
    ]);
    await client.newSession("/work", {configOptions: [{configId: "fast-mode", type: "boolean", value: true}]});
    expect(fake.created[1]?.configOptions).toEqual([{configId: "fast-mode", type: "boolean", value: true}]);
});

test("a preview of a new session shows the standard speed it starts with; a resume preview keeps the stored one", async () => {
    const {client} = await make();
    expect((await client.previewSession("/work")).configOptions).toEqual([{...fast, currentValue: false}]);
    expect((await client.previewSession("/work", {sessionId: "h1"})).configOptions).toEqual([fast]);
});
