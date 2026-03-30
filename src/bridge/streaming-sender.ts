import { chunkText } from "./chunker.js";

export interface StreamingSender {
  push(text: string): Promise<void>;
  flush(): Promise<void>;
  finish(finalTail?: string): Promise<void>;
}

export function createStreamingSender(params: {
  send: (text: string) => Promise<void>;
  flushIntervalMs: number;
  flushChars: number;
  maxChunkLen: number;
}): StreamingSender {
  const { send, flushIntervalMs, flushChars, maxChunkLen } = params;

  let pendingText = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let finished = false;
  let chain = Promise.resolve();

  const enqueue = (op: () => Promise<void>): Promise<void> => {
    chain = chain.then(op, op);
    return chain;
  };

  const clearFlushTimer = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  };

  const sendText = async (text: string): Promise<void> => {
    for (const chunk of chunkText(text, maxChunkLen)) {
      if (!chunk) continue;
      await send(chunk);
    }
  };

  const flushPending = async (): Promise<void> => {
    clearFlushTimer();
    if (!pendingText) return;

    const text = pendingText;
    pendingText = "";
    await sendText(text);
  };

  const scheduleFlush = (): void => {
    if (flushTimer || !pendingText || finished) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void enqueue(flushPending);
    }, flushIntervalMs);
  };

  return {
    push(text: string): Promise<void> {
      return enqueue(async () => {
        if (finished || !text) return;

        pendingText += text;
        if (pendingText.length >= flushChars) {
          await flushPending();
          return;
        }

        scheduleFlush();
      });
    },

    flush(): Promise<void> {
      return enqueue(flushPending);
    },

    finish(finalTail?: string): Promise<void> {
      return enqueue(async () => {
        finished = true;
        await flushPending();
        if (finalTail) {
          await sendText(finalTail);
        }
      });
    },
  };
}
