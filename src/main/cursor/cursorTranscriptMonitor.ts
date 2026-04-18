import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { ConnectionDebugInfo, MonitorEvent } from "../../shared/types.js";

interface CursorTranscriptMonitorOptions {
  transcriptRoot?: string;
  sourceId?: string;
  sourceLabel?: string;
  scanIntervalMs?: number;
  activeWindowMs?: number;
}

interface CursorTranscriptMonitorResolvedOptions {
  transcriptRoot: string;
  sourceId?: string;
  sourceLabel?: string;
  scanIntervalMs: number;
  activeWindowMs: number;
}

interface TranscriptRecord {
  role?: string;
  message?: {
    content?: Array<{
      type?: string;
      name?: string;
      input?: unknown;
      text?: string;
    }>;
  };
}

interface TranscriptFileState {
  path: string;
  offset: number;
  threadId: string;
  sourceLabel: string;
  lastSeenMs: number;
  started: boolean;
  currentTurnId?: string;
  awaitingFinal?: boolean;
}

type EventListener = (event: MonitorEvent) => void | Promise<void>;

const DEFAULT_SCAN_INTERVAL_MS = 1_500;
const DEFAULT_ACTIVE_WINDOW_MS = 45 * 60 * 1_000;

export class CursorTranscriptMonitor {
  private readonly options: CursorTranscriptMonitorResolvedOptions;
  private readonly listeners = new Set<EventListener>();
  private readonly files = new Map<string, TranscriptFileState>();
  private scanTimer?: NodeJS.Timeout;
  private scanInFlight = false;
  private connected = false;
  private initialized = false;
  private lastEventAt?: string;
  private errorMessage?: string;

  constructor(options: CursorTranscriptMonitorOptions = {}) {
    this.options = {
      transcriptRoot: options.transcriptRoot ?? getDefaultTranscriptRoot(),
      sourceId: options.sourceId,
      sourceLabel: options.sourceLabel,
      scanIntervalMs: options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS,
      activeWindowMs: options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS
    };
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.scanTimer) {
      return;
    }

    this.connected = true;
    this.initialized = true;
    this.errorMessage = undefined;

    await this.emitEvent({
      timestamp: new Date().toISOString(),
      kind: "lifecycle.connected",
      raw: {
        mode: "auto",
        transcriptRoot: this.options.transcriptRoot
      }
    });

    await this.emitEvent({
      timestamp: new Date().toISOString(),
      kind: "server.initialized",
      preview: "cursor-transcripts/auto",
      raw: {
        mode: "auto",
        transcriptRoot: this.options.transcriptRoot
      }
    });

    await this.scanOnce();
    this.scanTimer = setInterval(() => {
      void this.scanOnce();
    }, this.options.scanIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = undefined;
    }

    const wasConnected = this.connected || this.initialized;
    this.connected = false;
    this.initialized = false;
    this.files.clear();

    if (wasConnected) {
      await this.emitEvent({
        timestamp: new Date().toISOString(),
        kind: "lifecycle.disconnected",
        raw: {
          mode: "auto",
          transcriptRoot: this.options.transcriptRoot
        }
      });
    }
  }

  getConnectionDebugInfo(): ConnectionDebugInfo {
    const activeFiles = [...this.files.values()]
      .sort((left, right) => right.lastSeenMs - left.lastSeenMs)
      .map((file) => file.path);

    return {
      mode: "auto",
      listenUrl: this.options.transcriptRoot,
      listenUrls: activeFiles,
      connected: this.connected,
      initialized: this.initialized,
      connectedSources: activeFiles.length,
      initializedSources: activeFiles.length,
      totalSources: activeFiles.length,
      lastEventAt: this.lastEventAt,
      errorMessage: this.errorMessage,
      errorMessages: this.errorMessage ? [this.errorMessage] : []
    };
  }

  private async scanOnce(): Promise<void> {
    if (this.scanInFlight) {
      return;
    }
    this.scanInFlight = true;

    try {
      const now = Date.now();
      const files = await listJsonlFiles(this.options.transcriptRoot);

      for (const path of files) {
        const stats = await stat(path);
        if (now - stats.mtimeMs > this.options.activeWindowMs) {
          continue;
        }

        const fileState =
          this.files.get(path) ??
          ({
            path,
            offset: computeInitialTranscriptOffset(stats.size),
            threadId: basename(path, ".jsonl"),
            sourceLabel: basename(path),
            lastSeenMs: stats.mtimeMs,
            started: false,
            currentTurnId: undefined,
            awaitingFinal: false
          } satisfies TranscriptFileState);

        fileState.lastSeenMs = stats.mtimeMs;
        this.files.set(path, fileState);
        await this.readAppendedRecords(fileState);
      }

      for (const [path, fileState] of this.files) {
        if (now - fileState.lastSeenMs > this.options.activeWindowMs) {
          this.files.delete(path);
        }
      }
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      this.scanInFlight = false;
    }
  }

  private async readAppendedRecords(fileState: TranscriptFileState): Promise<void> {
    const contents = await readFile(fileState.path, "utf8");
    if (contents.length <= fileState.offset) {
      return;
    }

    const chunk = contents.slice(fileState.offset);
    const endsWithNewline = chunk.endsWith("\n");
    const lines = chunk.split("\n");
    const completeLines = endsWithNewline ? lines.filter(Boolean) : lines.slice(0, -1).filter(Boolean);

    if (completeLines.length === 0) {
      return;
    }

    fileState.offset += completeLines.reduce((total, line) => total + line.length + 1, 0);

    for (const line of completeLines) {
      const record = parseTranscriptRecord(line);
      if (!record) {
        continue;
      }
      const events = mapTranscriptRecordToEvents(record, fileState);
      for (const event of events) {
        await this.emitEvent(event);
      }
    }
  }

  private async emitEvent(event: MonitorEvent): Promise<void> {
    const enrichedEvent: MonitorEvent = {
      ...event,
      sourceId: event.sourceId ?? this.options.sourceId ?? "auto:cursor",
      sourceLabel: event.sourceLabel ?? this.options.sourceLabel ?? "cursor auto"
    };

    this.lastEventAt = enrichedEvent.timestamp;
    for (const listener of this.listeners) {
      await listener(enrichedEvent);
    }
  }
}

function getDefaultTranscriptRoot(): string {
  const envRoot = process.env.CURSOR_AGENT_TRANSCRIPTS_DIR?.trim();
  if (envRoot) {
    return envRoot;
  }

  const cwd = process.cwd().replace(/^\/+/, "");
  const projectSlug = cwd.replace(/[\/\\]/g, "-");
  return join(homedir(), ".cursor", "projects", projectSlug, "agent-transcripts");
}

function parseTranscriptRecord(line: string): TranscriptRecord | undefined {
  try {
    return JSON.parse(line) as TranscriptRecord;
  } catch {
    return undefined;
  }
}

function mapTranscriptRecordToEvents(
  record: TranscriptRecord,
  fileState: TranscriptFileState
): MonitorEvent[] {
  const timestamp = new Date().toISOString();
  const threadId = fileState.threadId;
  const sourceId = `cursor:${threadId}`;
  const sourceLabel = fileState.sourceLabel;
  const role = typeof record.role === "string" ? record.role : undefined;
  const content = Array.isArray(record.message?.content) ? record.message?.content : [];

  if (!fileState.started) {
    fileState.started = true;
    return [
      {
        timestamp,
        kind: "thread.started",
        threadId,
        status: "idle",
        preview: sourceLabel,
        sourceId,
        sourceLabel,
        raw: record
      }
    ];
  }

  if (role === "user") {
    const turnId = `${threadId}:${Date.now()}`;
    fileState.currentTurnId = turnId;
    fileState.awaitingFinal = true;
    // 用户刚提问后先进入思考，不直接显示执行中。
    return [
      {
        timestamp,
        kind: "thread.status.changed",
        threadId,
        status: "active",
        stateHint: "thinking",
        sourceId,
        sourceLabel,
        raw: record
      },
      {
        timestamp,
        kind: "turn.started",
        threadId,
        turnId,
        status: "active",
        stateHint: "thinking",
        sourceId,
        sourceLabel,
        raw: record
      }
    ];
  }

  if (role !== "assistant") {
    return [];
  }

  const toolUses = content.filter((item) => item && item.type === "tool_use");
  const textItems = content.filter((item) => item && item.type === "text");
  const events: MonitorEvent[] = [];
  const turnId = fileState.currentTurnId ?? `${threadId}:${Date.now()}`;
  fileState.currentTurnId = turnId;
  const combinedText = textItems
    .map((item) => (typeof item.text === "string" ? item.text : ""))
    .join(" ")
    .trim();

  const planningLike = /planning next move/i.test(combinedText);

  if (toolUses.length > 0) {
    fileState.awaitingFinal = true;
    let activeStateHint: MonitorEvent["stateHint"] = "working";

    for (const toolUse of toolUses) {
      const stateHint = classifyToolStateHint(toolUse.name);
      if (stateHint === "editing") {
        activeStateHint = "editing";
      } else if (stateHint === "working" && activeStateHint !== "editing") {
        activeStateHint = "working";
      }

      events.push({
        timestamp,
        kind: "item.started",
        threadId,
        turnId,
        itemType: "dynamicToolCall",
        stateHint,
        preview: typeof toolUse.name === "string" ? toolUse.name : "tool_use",
        sourceId,
        sourceLabel,
        raw: toolUse
      });
    }

    events.unshift({
      timestamp,
      kind: "thread.status.changed",
      threadId,
      turnId,
      status: "active",
      stateHint: activeStateHint,
      sourceId,
      sourceLabel,
      raw: record
    });
  }

  if (textItems.length > 0) {
    const textPreview = combinedText.slice(0, 400);

    events.push({
      timestamp,
      kind: "item.agentMessage.delta",
      threadId,
      turnId,
      delta: textPreview || "assistant response",
      stateHint: planningLike ? "thinking" : toolUses.length > 0 ? "working" : "typing",
      sourceId,
      sourceLabel,
      raw: record
    });
  }

  // 只要出现了“纯文本回复”（这一条 assistant record 里没有 tool_use），就视为一个回合完成。
  // 这样可以避免 tool_use 后一直卡在 working。
  if (toolUses.length === 0 && textItems.length > 0 && fileState.awaitingFinal) {
    // 先给一次提醒（notification），再落到 happy(success)。
    events.push({
      timestamp,
      kind: "thread.status.changed",
      threadId,
      turnId,
      status: "active",
      activeFlags: ["waitingOnApproval"],
      stateHint: "approval",
      sourceId,
      sourceLabel,
      raw: record
    });
    events.push({
      timestamp,
      kind: "turn.completed",
      threadId,
      turnId,
      status: "completed",
      stateHint: "success",
      sourceId,
      sourceLabel,
      raw: record
    });
    events.push({
      timestamp,
      kind: "thread.status.changed",
      threadId,
      status: "idle",
      activeFlags: [],
      sourceId,
      sourceLabel,
      raw: record
    });
    fileState.awaitingFinal = false;
    fileState.currentTurnId = undefined;
  }

  return events;
}

function classifyToolStateHint(name: unknown): MonitorEvent["stateHint"] {
  if (typeof name !== "string") {
    return "working";
  }

  const normalized = name.toLowerCase();
  if (
    normalized.includes("download") ||
    normalized.includes("fetch") ||
    normalized.includes("install") ||
    normalized.includes("curl") ||
    normalized.includes("wget")
  ) {
    return "editing"; // main.ts 里 editing -> carrying
  }

  if (
    normalized.includes("write") ||
    normalized.includes("edit") ||
    normalized.includes("applypatch") ||
    normalized.includes("strreplace")
  ) {
    return "working"; // main.ts 里 working 会走 building/typing 分支
  }

  return "working";
}

/** 默认从 EOF 起监听；设置 `CURSOR_TRANSCRIPT_REPLAY_BYTES` 或 `DESK_AUTO_REPLAY_TAIL_BYTES` 可重放尾部做实验 */
function computeInitialTranscriptOffset(fileSize: number): number {
  const specific = process.env.CURSOR_TRANSCRIPT_REPLAY_BYTES?.trim();
  const shared = process.env.DESK_AUTO_REPLAY_TAIL_BYTES?.trim();
  const raw = specific && specific.length > 0 ? specific : (shared ?? "");
  const bytes = Number.parseInt(raw, 10);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return fileSize;
  }
  return Math.max(0, fileSize - bytes);
}

async function listJsonlFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonlFiles(absolutePath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(absolutePath);
    }
  }
  return files;
}
