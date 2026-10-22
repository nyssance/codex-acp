import {afterEach, expect, it, vi} from 'vitest';
import type {ThreadItem} from '../../app-server/v2';
import {projectHistoryItem} from '../../alwith/agent/historyProjection';
import {AgentDirectory} from '../../alwith/bridge/agentDirectory';
import {connectSession, createTurn, itemCompleted, itemStarted, userMessageItem, turnStarted, turnCompleted, turnId, type PromptSession} from './v2-prompt-harness';
const clients: PromptSession[] = [];
afterEach(() => {for (const client of clients.splice(0)) client.connection.close();});
const question: Extract<ThreadItem, {type: 'agentMessage'}> = {
    type: 'agentMessage', id: 'async-question', text: '', phase: 'final_answer', memoryCitation: null,
    delivery: 'async', questions: [{title: 'Which environment?', options: ['Local', 'Remote']}],
};
it('keeps question-only native messages structured without waiting for user interaction', async () => {
    const client = await connectSession(); clients.push(client);
    client.setTurnStart(async () => ({turn: createTurn('inProgress')}));
    const prompt = client.sendPrompt([{type: 'text', text: 'go'}]);
    await vi.waitFor(() => expect(client.turnStartParams).toHaveLength(1));
    client.emit(turnStarted());
    client.emit(itemCompleted(userMessageItem(client.turnStartParams[0]!['clientUserMessageId'] as string)));
    await prompt;
    const start = client.transcript.length;
    client.emit(itemStarted(question)); client.emit(itemCompleted(question));
    await vi.waitFor(() => expect(client.transcript.slice(start).filter(entry => 'sessionUpdate' in entry && entry.sessionUpdate.sessionUpdate === 'agent_message')).toHaveLength(1));
    const updates = client.transcript.slice(start).flatMap(entry => 'sessionUpdate' in entry ? [entry.sessionUpdate] : []);
    expect(updates).toContainEqual(expect.objectContaining({messageId: question.id, _meta: {codex: {turnId, phase: question.phase, delivery: 'async', questions: question.questions}}}));
    expect(updates.some(update => update.sessionUpdate === 'state_update')).toBe(false);
    client.emit(turnCompleted()); await client.promptRunFinished();
});
it('preserves structured question metadata and every reply identity in native history', async () => {
    const directory = new AgentDirectory(async () => {throw new Error('Unexpected agent lookup');});
    const projected = await projectHistoryItem(question, directory, turnId);
    expect(projected.omissions).toEqual([]);
    expect(projected.updates).toContainEqual(expect.objectContaining({messageId: question.id, _meta: expect.objectContaining({codex: expect.objectContaining({delivery: 'async', questions: question.questions})})}));
    const replies = [{questionItemId: JSON.stringify(['request_user_input_async', question.id, 0]), question: 'Which environment?', answer: 'Remote'}];
    const history = await projectHistoryItem(userMessageItem('reply', `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`), directory, turnId);
    expect(history.omissions).toEqual([]);
    expect(history.updates).toContainEqual(expect.objectContaining({messageId: 'reply', content: [{type: 'text', text: 'Which environment?\nRemote', _meta: {codex: {questionReply: replies[0]}}}]}));
});
