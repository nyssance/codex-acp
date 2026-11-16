export type BackgroundTerminal = {itemId: string; processId: string; command: string};
export type BackgroundTerminalStopResult = {stopped: string[]; failures: {processId: string; message: string}[]};
