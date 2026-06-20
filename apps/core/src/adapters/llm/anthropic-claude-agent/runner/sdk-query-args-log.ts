import fs from 'fs';

export interface WriteSdkQueryArgsPayloadLogsInput {
  payload: unknown;
  historyPath?: string;
  latestPath: string;
}

export function writeSdkQueryArgsPayloadLogs(
  input: WriteSdkQueryArgsPayloadLogsInput,
): void {
  const serialized = JSON.stringify(input.payload, null, 2);
  if (input.historyPath) {
    fs.appendFileSync(input.historyPath, `${JSON.stringify(input.payload)}\n`);
  }
  fs.writeFileSync(input.latestPath, `${serialized}\n`);
}
