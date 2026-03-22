import fs from "node:fs";
import path from "node:path";

export interface PersistedState {
  credentials?: {
    token: string;
    accountId: string;
    baseUrl: string;
    userId?: string;
  };
  getUpdatesBuf?: string;
}

export class StateManager {
  private filePath: string;
  private state: PersistedState = {};

  constructor(stateDir: string) {
    fs.mkdirSync(stateDir, { recursive: true });
    this.filePath = path.join(stateDir, "state.json");
  }

  load(): PersistedState {
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      this.state = JSON.parse(raw) as PersistedState;
    } catch {
      this.state = {};
    }
    return this.state;
  }

  save(): void {
    fs.writeFileSync(
      this.filePath,
      JSON.stringify(this.state, null, 2),
      "utf-8",
    );
  }

  get(): PersistedState {
    return this.state;
  }

  update(partial: Partial<PersistedState>): void {
    Object.assign(this.state, partial);
    this.save();
  }
}
