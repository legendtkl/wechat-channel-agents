# Streaming Output Design

## Goal

Enable WeChat replies to appear incrementally while Claude or Codex is still generating, instead of waiting for the full turn to finish.

## Constraints

- The current WeChat integration sends immutable text messages; there is no existing edit-message API in the repository.
- `dispatcher.ts` is the single orchestration point for agent execution, formatting, typing state, and reply delivery.
- Codex already exposes structured streaming events through `runStreamed()`.
- Claude currently iterates the SDK stream, but only returns the final aggregated response to the dispatcher.

## Chosen Approach

Implement streaming as incremental message delivery, not message replacement.

- Extend the agent interface with an optional text-delta callback.
- Keep the existing `run()` contract so callers still receive a final `AgentResponse`.
- Add a dispatcher-side batching sender that buffers deltas and flushes when either:
  - 2 seconds have elapsed since the last send, or
  - 300 characters are waiting.
- Flush any remaining buffered text when the turn ends.
- Send tool summaries and error markers only in the final tail message to avoid noisy mid-stream updates.

## Why This Approach

This matches the current architecture with the smallest surface-area change:

- No WeChat protocol changes are required.
- Claude and Codex can expose incremental text through a shared interface.
- Existing session persistence and agent switching logic stay intact.
- The dispatcher remains the only place that knows how to batch and send messages.

## Non-Goals

- Editing or retracting previously sent messages.
- Streaming tool execution logs to WeChat in real time.
- Adding user-configurable batching thresholds in this iteration.

## Data Flow

1. Dispatcher starts typing loop and creates a batching sender.
2. Agent backend emits text deltas through `onTextDelta`.
3. Batching sender accumulates deltas and sends chunked WeChat messages on threshold.
4. Agent returns the final response with `toolsUsed` and `isError`.
5. Dispatcher flushes any remaining text, then optionally sends a final summary/error tail.

## Edge Cases

- If the agent fails after partial output, flush buffered text first, then send the error message.
- If no deltas are emitted, keep the existing one-shot final send behavior.
- Codex item updates must not resend previously observed text; per-item sent length must be tracked.
- Claude streaming should prefer partial stream events, with fallback to full assistant messages when partial deltas are unavailable.
