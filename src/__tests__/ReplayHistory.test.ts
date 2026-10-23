import {expect, it} from 'vitest';
import type {Turn, ThreadItemEntry} from '../app-server/v2';
import {replayEntriesOfTurn, withReplayTurnMetadata} from '../ReplayHistory';

const turn = (id: string, overrides: Partial<Turn> = {}): Turn => ({
    id, rootTurnId: null, itemsView: 'full', status: 'completed', error: null,
    startedAt: 10, completedAt: 12, durationMs: 2000, items: [], ...overrides,
});
async function* pages<T>(values: T[]) {for (const value of values) yield [value];}
async function collect<T>(values: AsyncIterable<T[]>) {const result: T[] = []; for await (const page of values) result.push(...page); return result;}

it('preserves timestamps and interrupted status, assigning sent time only to the opening user message', () => {
    const value = turn('interrupted', {status: 'interrupted', items: [
        {type: 'userMessage', id: 'first', clientId: null, content: []},
        {type: 'userMessage', id: 'steer', clientId: null, content: []},
    ]});
    const [first, steer] = replayEntriesOfTurn(value);
    expect(first?.replayMeta).toEqual({historyReplay: true, turnId: 'interrupted', turnStartedAt: 10000,
        turnCompletedAt: 12000, turnDurationMs: 2000, messageSentAt: 10000, historyInterrupted: true});
    expect(steer?.replayMeta).not.toHaveProperty('messageSentAt');
});

it('renders a failed empty turn between adjacent turns without moving its error to the transcript end', async () => {
    const before = turn('before', {items: [{type: 'userMessage', id: 'first', clientId: null, content: []}]});
    const failed = turn('failed', {status: 'failed', error: {
        message: 'Capacity exhausted', additionalDetails: null, codexErrorInfo: 'serverOverloaded', misalignment: null,
    }});
    const after = turn('after', {items: [{type: 'userMessage', id: 'last', clientId: null, content: []}]});
    const entries: ThreadItemEntry[] = [before, after].flatMap(value => value.items.map(item => ({
        turnId: value.id, item, startedAtMs: null, completedAtMs: null,
    })));
    const output = await collect(withReplayTurnMetadata(pages(entries), pages([before, failed, after])));
    expect(output.map(entry => entry.item.id)).toEqual(['first', 'codex-error:failed', 'last']);
    expect(output[1]?.replayMeta).toMatchObject({turnId: 'failed', historyReplay: true,
        error: {codexErrorInfo: 'serverOverloaded', message: 'Capacity exhausted'}});
    expect(output).toEqual([before, failed, after].flatMap(replayEntriesOfTurn));
});

it('rejects history whose entries have no corresponding turn instead of silently losing them', async () => {
    const entry: ThreadItemEntry = {turnId: 'missing', item: {type: 'userMessage', id: 'lost', clientId: null, content: []}, startedAtMs: null, completedAtMs: null};
    await expect(collect(withReplayTurnMetadata(pages([entry]), pages([]))))
        .rejects.toThrow('no matching turn metadata: missing');
});
