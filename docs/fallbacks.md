# Registered workarounds

The fork fails loudly on missing or invalid state. The entries below are the exceptions: each one works
around a gap in Codex, a backend, or the protocol that the fork cannot fix itself. Each entry names
where it lives, why it is needed, and when it can go. Add a row here before adding a workaround to the
code; a gap that can be fixed in this repository is not a workaround.

## Codex app-server

| Where | Workaround | Why | Remove when |
|---|---|---|---|
| `src/alwith/agent/historyTitle.ts` `sessionTitle` | Reads the first page of turns when a preview starts with a serialized attachment or reply envelope. | Codex builds `preview` from the rendered prompt text, which can start with an attachment or cut through a URI. | Codex derives the preview from the user's text only. |
| `src/alwith/codex/sessionConfig.ts` `fileReference` and attachment envelopes | Rebuilds file and attachment blocks from the text Codex stores. | Codex stores user input as rendered text, so the structure is lost. | Codex persists structured user input. |
| `src/alwith/agent/historyProtocol.ts` `HistoryRead.fitting` | Re-reads the same cursor with half the count until a page fits `maxBytes`. | Native cursors are opaque and Codex has no byte limit on `thread/turns/list`. | Codex accepts a byte limit. |
| `src/alwith/agent/historyProtocol.ts` `sourceError` | Classifies native errors by message text. | Codex returns these errors without structured codes. | Codex returns error codes. |
| `src/client/CodexClient.ts` `deleteRemote` | Treats `no rollout found for thread id <id>` as an idempotent delete. | Same: no structured code for a missing thread. | Same as above. |
| `src/CodexAcpServer.ts`, before `rebindSessionProvider` resumes | Sends `thread/section/move` with `sectionId: null` to a thread without a rollout. | A model change resumes the thread, and only a thread with a rollout resumes. Placing a thread in no section is the one request that writes the rollout without history (`src/__tests__/integration/thread-materialize.test.ts`). | Codex can change a thread's model before its first turn without a resume. |
| `src/CodexAcpServer.ts` `rebindSessionProvider`, "Failed native threads can remain cached" | Rebuilds the provider connection when `thread/resume` ignores the model override. | A failed native thread stays cached and ignores every resume override. | Codex drops failed threads from its cache or applies overrides to them. |
| `src/CodexEventHandler.ts` turn timing | Caps the work duration at the turn's own duration. | Codex reports a turn's start in whole seconds and the final answer in milliseconds. | Codex reports turn start in milliseconds. |
| `src/CodexEventHandler.ts` `guardianWarning` | Drops a warning whose text starts with "Automatic approval review … (risk:". | Codex also reports that review summary as an auto-approval review item, and only the message text tells a summary from a failure. | Codex marks guardian warnings with a structured kind. |
| `src/client/history.ts` `exportConversation` | Uses the session creation time for an item without `startedAtMs`. | Older Codex rollouts have no item timestamps, and the archive format requires one. | Rollouts without item timestamps are no longer supported. |
| `src/CodexJsonRpcConnection.ts` | Waits 2 seconds before `SIGTERM` and for stdout after a provider child exits. | Mirrors the grace periods of upstream's app-server supervisor. | Upstream exposes its timings for reuse. |

## Backends and protocols

| Where | Workaround | Why | Remove when |
|---|---|---|---|
| `src/alwith/codex/responsesCompatibility.ts` | Strips `reasoning` and `additional_tools` input items and rewrites the model id for gateways. | OpenAI-compatible gateways reject these Responses inputs. | The gateways accept them. |
| `src/alwith/codex/responsesProxy.ts` realtime routes | Rewrites `/live` to `/realtime/calls?intent=quicksilver&architecture=avas` and multipart to JSON. | The ChatGPT backend expects this form, while Codex derives the API form from the local URL. | Codex selects the backend form itself. |
| `src/alwith/codex/responsesProxy.ts` `paymentRequiredNotice` | Forwards an external provider's HTTP 402 to Codex as 429 `usage_limit_reached`, with the provider host, the 402 and the provider's message in `x-codex-promo-message`. The proxy diagnostic keeps `status: 402` and `forwardedStatus: 429`. | DeepSeek reports an exhausted balance as 402. Codex knows only OpenAI's 429 forms and retries any other status as a connection failure. | DeepSeek returns OpenAI's 429 `insufficient_quota`, or Codex recognizes 402. |
| `src/alwith/codex/images.ts`, `remotePluginEnablement.ts` | Retries once after refreshing the token on HTTP 401. | Mirrors Codex's own refresh on 401. | — (matches Codex) |
