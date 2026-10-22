import type {ServerNotification} from "../../app-server";
import type {ThreadForkParams, ThreadForkResponse, ThreadUnsubscribeParams, ThreadUnsubscribeResponse, TurnStartParams, TurnCompletedNotification} from "../../app-server/v2";
import {abortable} from "../util/abort";
import {logger} from "../../Logger";
import type { CodexAppServerClient } from "../../CodexAppServerClient"
import type { GetAuthStatusParams } from "../../app-server/GetAuthStatusParams"
import type { GetAuthStatusResponse } from "../../app-server/GetAuthStatusResponse"
import type {
  GetAccountParams, GetAccountResponse, ThreadReadParams, ThreadReadResponse,
  ThreadTurnsListParams, ThreadTurnsListResponse, ThreadItemsListParams, ThreadItemsListResponse
} from "../../app-server/v2"

/** A view of the current upstream app-server, never a second process or connection. */
export class AppServerClient {
  private readonly signals = new WeakMap<CodexAppServerClient, AbortSignal>()
  constructor(private readonly current: () => CodexAppServerClient) {}

  snapshot(): AppServerClient {
    const client = this.current()
    return new AppServerClient(() => client)
  }

  get disconnectSignal(): AbortSignal {
    const client = this.current()
    let signal = this.signals.get(client)
    if (!signal) {
      const controller = new AbortController()
      signal = controller.signal
      client.connectionLoss.onLost(() => controller.abort(new Error("Codex app-server disconnected")))
      this.signals.set(client, signal)
    }
    return signal
  }

  request<T>(method: string, params: unknown): Promise<T> {
    return this.current().connection.sendRequest<T>(method, params)
  }
  threadRead(params: ThreadReadParams): Promise<ThreadReadResponse> { return this.current().threadRead(params) }
  threadTurnsList(params: ThreadTurnsListParams): Promise<ThreadTurnsListResponse> {
    return this.request("thread/turns/list", params)
  }
  threadItemsList(params: ThreadItemsListParams): Promise<ThreadItemsListResponse> {
    return this.request("thread/items/list", params)
  }
  observeNotifications(callback: (notification: ServerNotification) => void): () => void {
    return this.current().onClientTransportEvent(event => {if (event.eventType === "notification") callback(event);});
  }
  threadFork(params: ThreadForkParams): Promise<ThreadForkResponse> {return this.current().threadFork(params);}
  threadUnsubscribe(params: ThreadUnsubscribeParams): Promise<ThreadUnsubscribeResponse> {return this.current().threadUnsubscribe(params);}
  async runTurn(params: TurnStartParams, started?: (id: string) => void, signal?: AbortSignal): Promise<TurnCompletedNotification> {
    const client = this.current();
    let turnId: string | undefined;
    const interrupt = () => {
      if (turnId) void client.turnInterrupt({threadId: params.threadId, turnId}).catch(error => logger.error("Failed to interrupt prediction", error));
    };
    signal?.throwIfAborted();
    signal?.addEventListener("abort", interrupt, {once: true});
    const pending = client.runTurn(params, id => {turnId = id; started?.(id); if (signal?.aborted) interrupt();});
    try {return await (signal ? abortable(pending, signal) : pending);}
    finally {signal?.removeEventListener("abort", interrupt);}
  }
  accountRead(params: GetAccountParams): Promise<GetAccountResponse> { return this.request("account/read", params) }
  getAuthStatus(params: GetAuthStatusParams): Promise<GetAuthStatusResponse> { return this.request("getAuthStatus", params) }
}
