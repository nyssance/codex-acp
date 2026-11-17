# Registered workarounds

The fork fails loudly on missing or invalid state. The entries below are the exceptions: each one works
around a gap in Codex, a backend, or the protocol that the fork cannot fix itself. Each entry names
where it lives, why it is needed, and when it can go. Add a row here before adding a workaround to the
code; a gap that can be fixed in this repository is not a workaround.

## Codex app-server

| Where | Workaround | Why | Remove when |
|---|---|---|---|
| `src/alwith/agent/historyTitle.ts` `sessionTitle` | Reads the first page of turns when a preview starts with a serialized attachment or reply envelope. | Codex builds `preview` from the rendered prompt text, which can start with an attachment or cut through a URI. | Codex derives the preview from the user's text only. |
| `src/alwith/agent/historyProtocol.ts` `HistoryRead.fitting` | Re-reads the same cursor with half the count until a page fits `maxBytes`. | Native cursors are opaque and Codex has no byte limit on `thread/turns/list`. | Codex accepts a byte limit. |
| `src/alwith/agent/historyProtocol.ts` `sourceError` | Classifies native errors by message text. | Codex returns these errors without structured codes. | Codex returns error codes. |
| `src/client/CodexClient.ts` `deleteRemote` | Treats `no rollout found for thread id <id>` as an idempotent delete. | Same: no structured code for a missing thread. | Same as above. |
| `src/CodexAcpServer.ts`, before `rebindSessionProvider` resumes | Sends `thread/section/move` with `sectionId: null` to a thread without a rollout. | A model change resumes the thread, and only a thread with a rollout resumes. Placing a thread in no section is the one request that writes the rollout without history (`src/__tests__/integration/thread-materialize.test.ts`). | Codex can change a thread's model before its first turn without a resume. |
| `src/CodexAcpServer.ts` `rebindSessionProvider`, "Failed native threads can remain cached" | Rebuilds the provider connection when `thread/resume` ignores the model override. | A failed native thread stays cached and ignores every resume override. | Codex drops failed threads from its cache or applies overrides to them. |
| `src/CodexEventHandler.ts` turn timing | Caps the work duration at the turn's own duration. | Codex reports a turn's start in whole seconds and the final answer in milliseconds. | Codex reports turn start in milliseconds. |
| `src/CodexEventHandler.ts` `guardianWarning` | Drops a warning whose text starts with "Automatic approval review … (risk:". | Codex also reports that review summary as an auto-approval review item, and only the message text tells a summary from a failure. | Codex marks guardian warnings with a structured kind. |
| `src/client/history.ts` `exportConversation` | Uses the session creation time for an item without `startedAtMs`. | Older Codex rollouts have no item timestamps, and the archive format requires one. | Rollouts without item timestamps are no longer supported. |
| `src/CodexJsonRpcConnection.ts`, `src/ProviderConnections.ts` | Starts one Codex app-server per model provider and routes each thread's requests to the process of its provider. Upstream's `CodexAppServerSupervisor` stops each of them. When one dies unexpectedly, the primary is ended too, so upstream's recovery reconnects every session. | `model_provider` applies to a whole app-server process, and a thread cannot change provider. | Codex accepts the model provider per thread. |
| `src/CodexAcpServer.ts` `rebindSessionProvider`, `src/CodexAcpClient.ts` system prompt change | After `thread/unsubscribe`, waits up to 10 seconds for `thread/status/changed: notLoaded`; when `thread/resume` then answers that the thread is closing, waits up to 10 seconds for `thread/closed` and resumes once more. | Codex 0.167.2 can report the unload before it finishes closing the thread and rejects a resume in between. | Codex reports the unload only after the thread is closed. |
| `src/CodexThreadErrors.ts` `isThreadClosingError`, `isModelProviderRouteError` | Recognize "is closing; retry thread/resume" and the "This chat uses model provider …" messages by their text. | Codex returns these errors without structured codes. | Codex returns error codes. |
| `src/CodexAcpClient.ts` `restoreCatalogRoute` | When a resume, load or fork fails with the provider route error, reads the thread and retries it as a catalog session if its model starts with `native:` or `gateway:`. | A catalog session's provider is recorded in the rollout, and only the model id the fork wrote tells it apart after a restart. | Codex lets a thread change provider. |
| `src/alwith/codex/sessionInputConfig.ts` | Treats `-32602` "thread not found" from `thread/attachment/list` as a draft without stored input configuration, after checking with `thread/read` that the thread exists. | A loaded draft has no rollout to own attachments until its first message, and Codex reports that only by message text. | Codex lists attachments of a loaded draft, or returns a code. |
| `src/alwith/codex/externalCompaction.ts` | Answers Codex's remote compaction request (`compaction_trigger`) for a gateway: asks the gateway model for Codex's handoff summary, returns it as the single `compaction` item, and turns that item back into the summary message in later requests. | A thread that started on OpenAI stays on the built-in provider, and Codex then asks every gateway for server-side compaction, which only OpenAI implements. | Codex compacts locally for a provider without remote compaction. |

## Backends and protocols

| Where | Workaround | Why | Remove when |
|---|---|---|---|
| `src/alwith/codex/responsesCompatibility.ts` | Strips `reasoning` and `additional_tools` input items and rewrites the model id for gateways. | OpenAI-compatible gateways reject these Responses inputs. | The gateways accept them. |
| `src/alwith/codex/responsesProxy.ts` realtime routes | Rewrites `/live` to `/realtime/calls?intent=quicksilver&architecture=avas` and multipart to JSON. | The ChatGPT backend expects this form, while Codex derives the API form from the local URL. | Codex selects the backend form itself. |
| `src/alwith/codex/responsesProxy.ts` `paymentRequiredNotice` | Forwards an external provider's HTTP 402 to Codex as 429 `usage_limit_reached`, with the provider host, the 402 and the provider's message in `x-codex-promo-message`. The proxy diagnostic keeps `status: 402` and `forwardedStatus: 429`. | DeepSeek reports an exhausted balance as 402. Codex knows only OpenAI's 429 forms and retries any other status as a connection failure. | DeepSeek returns OpenAI's 429 `insufficient_quota`, or Codex recognizes 402. |
| `src/alwith/codex/images.ts`, `remotePluginEnablement.ts` | Retries once after refreshing the token on HTTP 401. | Mirrors Codex's own refresh on 401. | — (matches Codex) |
