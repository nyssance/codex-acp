import * as acp from "@agentclientprotocol/sdk/experimental/v2/unstable";
import type {CodexAppServerClient} from "../../CodexAppServerClient";
import {nativeForks} from "./forkIndex";
import {listedSessionTitle} from "../../SessionTitle";
import {historyTitle} from "./historyTitle";
const run = <T>(operation: () => Promise<T>): Promise<T> => operation();
export async function readSessionList(client: CodexAppServerClient, params: acp.ListSessionsRequest, all: boolean): Promise<acp.ListSessionsResponse> {
    if ((params.cwd !== undefined && params.cwd !== null && typeof params.cwd !== "string")
      || (params.cursor !== undefined && params.cursor !== null && typeof params.cursor !== "string")) {
      throw acp.RequestError.invalidParams(undefined, "Expected string cwd and cursor");
    }
    const cwd = params.cwd?.trim() || null
    const archived = (params._meta as {codex?: {archived?: unknown}} | undefined)?.codex?.archived === true
    const list = (cursor: string | null) =>
      run(() =>
        client.threadList({
          cursor,
          ...(all ? { limit: 100 } : {}),
          ...(cwd ? { cwd } : {}),
          sourceKinds: ["cli", "vscode", "exec", "appServer", "unknown"],
          // Omitting this lets Codex hide threads created through another gateway.
          modelProviders: [],
          // Codex lists non-archived threads by default; the archive is a separate page.
          ...(archived ? { archived: true } : {})
        })
      )
    const response = await list(params.cursor ?? null)
    if (all) {
      const threads = new Map(response.data.map((thread) => [thread.id, thread]))
      const cursors = new Set<string>()
      while (response.nextCursor !== null) {
        const cursor = response.nextCursor
        if (cursors.has(cursor)) throw acp.RequestError.internalError(undefined, "Codex thread list repeated a cursor")
        cursors.add(cursor)
        const page = await list(cursor)
        for (const thread of page.data) threads.set(thread.id, thread)
        response.nextCursor = page.nextCursor
      }
      response.data = [...threads.values()]
    }
    const home = client.getCodexHome()
    if (home === null) throw acp.RequestError.internalError(undefined, "Codex home is unavailable after initialize")
    const forks = await run(() =>
      nativeForks(
        home,
        archived,
        cwd,
        async (id) => (await client.threadRead({ threadId: id, includeTurns: false })).thread
      )
    )
    const byId = new Map(forks.map((thread) => [thread.id, thread]))
    // Native list rows can lose forkedFromId after unload; thread/read retains the rollout lineage.
    response.data = response.data.map((thread) => byId.get(thread.id) ?? thread)
    if (!params.cursor) {
      const missing = new Map(byId)
      for (const thread of response.data) missing.delete(thread.id)
      // thread/read may hydrate a non-empty preview while the native list index still
      // excludes it. Check actual pages, not the hydrated preview; avoid duplicate rows.
      let cursor = response.nextCursor
      const cursors = new Set<string>()
      while (missing.size > 0 && cursor !== null) {
        if (cursors.has(cursor)) throw acp.RequestError.internalError(undefined, "Codex thread list repeated a cursor")
        cursors.add(cursor)
        const page = await list(cursor)
        for (const thread of page.data) missing.delete(thread.id)
        cursor = page.nextCursor
      }
      response.data.push(...missing.values())
    }
    const sessions: acp.SessionInfo[] = []
    // Full listings can need many title repairs; bound their history reads.
    const batchSize = all ? 8 : response.data.length
    for (let offset = 0; offset < response.data.length; offset += batchSize) {
      sessions.push(
        ...(await Promise.all(
          response.data.slice(offset, offset + batchSize).map(async (thread) => ({
            sessionId: thread.id,
            cwd: thread.cwd,
            // Native previews can start with a serialized attachment, or cut it
            // halfway through a URI. Read the first page only for those rows.
            title:
              !thread.name?.trim() &&
              /^(?:\[@|# Files mentioned by the user:|<send_user_message_question_reply>)/.test(
                thread.preview.trimStart()
              )
                ? historyTitle(thread, (await client.threadTurnsList({threadId: thread.id, cursor: null, limit: 25, itemsView: "full", sortDirection: "asc"})).data)
                : listedSessionTitle(thread),
            updatedAt: new Date(thread.updatedAt * 1000).toISOString(),
            _meta: { codex: { projectId: thread.projectId ?? null, archived, nativeSessionId: thread.sessionId, forkedFromId: thread.forkedFromId } }
          }))
        ))
      )
    }
    return all ? { sessions } : { sessions, nextCursor: response.nextCursor }
  }

