import { ISerializableChatData } from './types';

/**
 * Parse a .json chat session file.
 */
export function parseJsonSession(content: string): ISerializableChatData {
  const data = JSON.parse(content) as ISerializableChatData;

  if (!data.sessionId || !Array.isArray(data.requests)) {
    throw new Error('Invalid chat session format: missing sessionId or requests');
  }

  return data;
}
