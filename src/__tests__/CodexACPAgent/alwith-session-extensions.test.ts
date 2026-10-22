import {afterEach, expect, it, vi} from 'vitest';
import {connectSession, codexResponse, createThread, createTurn, turnStarted, turnCompleted, sessionId, turnId, type PromptSession} from './v2-prompt-harness';
const clients: PromptSession[] = [];
afterEach(() => {for (const client of clients.splice(0)) client.connection.close();});
it('injects seeded history into the native thread and advertises the requested mode', async () => {
    const start = vi.fn(async () => codexResponse('thread/start'));
    const inject = vi.fn(async () => ({}));
    const client = await connectSession(2, {newSessionMeta: {codex: {mode: 'read-only', seedHistory: [{role: 'user', text: 'prior question'}, {role: 'assistant', text: 'prior answer'}]}}, codexResponses: {'thread/start': start, 'thread/inject_items': inject}});
    clients.push(client);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({sandbox: 'read-only'}));
    expect(inject).toHaveBeenCalledWith({threadId: sessionId, items: [
        {type: 'message', role: 'user', content: [{type: 'input_text', text: 'prior question'}]},
        {type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'prior answer'}]},
    ]});
    const snapshot = await client.request('_alwith/config_snapshot', {sessionId});
    expect(snapshot.configOptions.find((option: {configId: string}) => option.configId === 'mode').currentValue).toBe('read-only');
});
it('retries only the latest eligible failed turn without duplicating user input', async () => {
    const client = await connectSession(); clients.push(client);
    const failed = {...createTurn('failed', 'failed-turn'), error: {message: 'busy', codexErrorInfo: 'serverOverloaded', additionalDetails: null, misalignment: null}};
    client.setCodexResponse('thread/turns/list', async () => ({data: [failed], nextCursor: null, backwardsCursor: null}));
    client.setCodexResponse('thread/read', async () => ({thread: createThread(), readState: null}));
    await expect(client.request('_codex/session_retry', {sessionId, turnId: 'stale-turn', trigger: 'automatic'})).rejects.toThrow('latest turn');
    expect(client.turnStartParams).toHaveLength(0);
    client.setTurnStart(async () => ({turn: createTurn('inProgress')}));
    const retry = client.request('_codex/session_retry', {sessionId, turnId: 'failed-turn', trigger: 'automatic'});
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
    expect(client.turnStartParams[0]).toMatchObject({input: [], turnTrigger: 'capacity_retry_automatic'});
    client.emit(turnStarted());
    await retry;
    client.emit(turnCompleted());
    await client.promptRunFinished();
});
it('runs composer predictions in an ephemeral native fork and closes it after delivery', async () => {
    const client = await connectSession(); clients.push(client);
    const fork = vi.fn(async () => ({thread: {...createThread(), id: 'prediction-thread', ephemeral: true}}));
    const unsubscribe = vi.fn(async () => ({}));
    client.setCodexResponse('thread/turns/list', async () => ({data: [createTurn('completed', 'source-turn')], nextCursor: null, backwardsCursor: null}));
    client.setCodexResponse('thread/fork', fork);
    client.setCodexResponse('thread/unsubscribe', unsubscribe);
    client.setTurnStart(async () => ({turn: createTurn('inProgress', 'prediction-turn')}));
    await client.request('_codex/session_prediction_request', {sessionId, sourceTurnId: 'source-turn'});
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
    expect(fork).toHaveBeenCalledWith(expect.objectContaining({threadId: sessionId, ephemeral: true, experimentalPredictionMode: true}));
    expect(client.turnStartParams[0]).toMatchObject({threadId: 'prediction-thread', turnTrigger: 'composer_predictions'});
    client.emit({method: 'item/completed', params: {threadId: 'prediction-thread', turnId: 'prediction-turn', completedAtMs: 1000, item: {type: 'agentMessage', id: 'prediction-message', text: '{"suggestion":"Continue"}', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null}}});
    client.emit({method: 'turn/completed', params: {threadId: 'prediction-thread', turn: createTurn('completed', 'prediction-turn')}});
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledWith({threadId: 'prediction-thread'}));
    await vi.waitFor(() => expect(client.transcript).toContainEqual({sessionUpdate: {sessionUpdate: 'session_info_update', _meta: {codex: {prediction: {sourceTurnId: 'source-turn', result: {type: 'completed', text: 'Continue'}}}}}}));
});
