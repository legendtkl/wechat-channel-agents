# Streaming Output Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add incremental WeChat reply delivery so agent output appears during generation.

**Architecture:** Keep `dispatcher.ts` as the only sender/orchestrator, extend the agent backend interface with an optional text-delta callback, and let each backend translate SDK-specific streaming events into normalized text deltas. Dispatcher batches those deltas into multiple immutable WeChat messages.

**Tech Stack:** TypeScript, Node.js 22, Vitest, `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`

---

### Task 1: Dispatcher Streaming Contract

**Files:**
- Modify: `src/agent/interface.ts`
- Modify: `src/bridge/dispatcher.ts`
- Test: `src/bridge/dispatcher.e2e.test.ts`

**Step 1: Write the failing test**

Add a dispatcher e2e test that registers a mock backend which calls `onTextDelta("hello ")`, waits, then `onTextDelta("world")`, and returns a final response with the same combined text. Assert that at least one incremental send occurs before the final tail handling, and that sent text does not duplicate the full body.

**Step 2: Run test to verify it fails**

Run: `npm test -- src/bridge/dispatcher.e2e.test.ts`
Expected: FAIL because the agent request has no streaming callback and dispatcher only sends once at the end.

**Step 3: Write minimal implementation**

- Extend `AgentRequest` with optional `onTextDelta`.
- Update dispatcher to pass the callback into `agent.run(...)`.

**Step 4: Run test to verify it passes**

Run: `npm test -- src/bridge/dispatcher.e2e.test.ts`
Expected: the new test reaches the callback path, but later tasks may still fail until batching is implemented.

**Step 5: Commit**

```bash
git add src/agent/interface.ts src/bridge/dispatcher.ts src/bridge/dispatcher.e2e.test.ts
git commit -m "feat: add dispatcher streaming contract"
```

### Task 2: Batching Sender

**Files:**
- Create: `src/bridge/streaming-sender.ts`
- Test: `src/bridge/streaming-sender.test.ts`
- Modify: `src/bridge/dispatcher.ts`

**Step 1: Write the failing test**

Create unit tests for a batching sender that:
- buffers incoming deltas,
- flushes when pending text exceeds 300 chars,
- flushes on `flush()`/`close()`,
- chunks oversized messages with `chunkText`,
- avoids sending empty strings.

**Step 2: Run test to verify it fails**

Run: `npm test -- src/bridge/streaming-sender.test.ts`
Expected: FAIL because the helper does not exist yet.

**Step 3: Write minimal implementation**

Create a helper that accepts:
- `push(rawText: string)`
- `flush()`
- `finish(finalTail?: string)`

The helper should preserve already-sent text boundaries and use existing `sendTextMessage`.

**Step 4: Run test to verify it passes**

Run: `npm test -- src/bridge/streaming-sender.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/bridge/streaming-sender.ts src/bridge/streaming-sender.test.ts src/bridge/dispatcher.ts
git commit -m "feat: batch streaming output for wechat replies"
```

### Task 3: Codex Delta Extraction

**Files:**
- Modify: `src/agent/codex/backend.ts`
- Test: `src/agent/codex/backend.test.ts`

**Step 1: Write the failing test**

Add a backend test with repeated `item.updated` / `item.completed` events for the same `agent_message` item. Assert that only the newly appended suffix is forwarded via `onTextDelta`.

**Step 2: Run test to verify it fails**

Run: `npm test -- src/agent/codex/backend.test.ts`
Expected: FAIL because the backend currently ignores streaming callbacks and only collects completed items.

**Step 3: Write minimal implementation**

- Handle `item.updated` as well as `item.completed`.
- Track per-item emitted length in a map keyed by item id.
- Forward only the unseen suffix to `onTextDelta`.

**Step 4: Run test to verify it passes**

Run: `npm test -- src/agent/codex/backend.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/codex/backend.ts src/agent/codex/backend.test.ts
git commit -m "feat: stream codex text deltas"
```

### Task 4: Claude Delta Extraction

**Files:**
- Modify: `src/agent/claude/backend.ts`
- Test: `src/agent/claude/backend.test.ts`

**Step 1: Write the failing test**

Add a backend test that feeds a sequence of Claude stream messages including partial stream events and final assistant/result messages. Assert that text deltas are emitted progressively and the final response remains correct.

**Step 2: Run test to verify it fails**

Run: `npm test -- src/agent/claude/backend.test.ts`
Expected: FAIL because the backend currently only records full assistant messages and never emits deltas.

**Step 3: Write minimal implementation**

- Detect partial stream events and extract incremental text when available.
- Fall back to full assistant message extraction if partial events are absent.
- Prevent duplicate delta emission between partial and final assistant messages.

**Step 4: Run test to verify it passes**

Run: `npm test -- src/agent/claude/backend.test.ts`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/agent/claude/backend.ts src/agent/claude/backend.test.ts
git commit -m "feat: stream claude text deltas"
```

### Task 5: End-to-End Verification

**Files:**
- Modify as needed based on test fixes

**Step 1: Run targeted tests**

Run: `npm test -- src/bridge/dispatcher.e2e.test.ts src/bridge/streaming-sender.test.ts src/agent/codex/backend.test.ts src/agent/claude/backend.test.ts`
Expected: PASS.

**Step 2: Run full suite**

Run: `npm test`
Expected: PASS.

**Step 3: Run type checking**

Run: `npm run typecheck`
Expected: PASS.

**Step 4: Review docs impact**

Check whether `README.md` or `docs/technical-guide.md` should mention streaming replies. Update only if the shipped behavior would otherwise be misleading.

**Step 5: Commit**

```bash
git add .
git commit -m "feat: stream incremental agent replies to wechat"
```
