import { Client } from "ssh2";
import { exec as cpExec, spawn } from "node:child_process";
import { readFileSync, openSync, closeSync } from "node:fs";
import { shellQuote, formatError } from "../ui/format.js";
import type {
  RemoteMachine,
  ExecResult,
  ConnectionStatus,
} from "./types.js";

export const LOCAL_MACHINE: RemoteMachine = {
  id: "local",
  host: "localhost",
  port: 0,
  username: process.env.USER ?? "local",
  authMethod: "local" as any,
  labels: ["local"],
};

interface PooledConnection {
  client: Client | null; // null for local
  machine: RemoteMachine;
  connected: boolean;
  lastUsedAt: number;
  reconnectAttempts: number;
  lastError?: string;
}

/** Max characters to buffer from a single command's stdout or stderr. */
const MAX_EXEC_OUTPUT = 512 * 1024; // 512 KB

function capOutput(str: string, max: number): string {
  if (str.length <= max) return str;
  const half = Math.floor(max / 2) - 40;
  const omitted = str.length - max + 80;
  return str.slice(0, half) + `\n\n... [${omitted} characters omitted] ...\n\n` + str.slice(-half);
}

export class ConnectionPool {
  private connections = new Map<string, PooledConnection>();
  private machines = new Map<string, RemoteMachine>();

  constructor() {
    // Always register the local machine
    this.machines.set("local", LOCAL_MACHINE);
    this.connections.set("local", {
      client: null,
      machine: LOCAL_MACHINE,
      connected: true,
      lastUsedAt: Date.now(),
      reconnectAttempts: 0,
    });
  }

  addMachine(machine: RemoteMachine): void {
    this.machines.set(machine.id, machine);
  }

  removeMachine(id: string): void {
    if (id === "local") return; // Can't remove local
    this.disconnect(id);
    this.machines.delete(id);
  }

  async connect(machineId: string): Promise<void> {
    if (machineId === "local") return; // Always connected

    const machine = this.machines.get(machineId);
    if (!machine) throw new Error(`Unknown machine: ${machineId}`);

    const existing = this.connections.get(machineId);
    if (existing?.connected) return;

    // Clean up any previous failed client before creating a new one
    if (existing?.client) {
      try { existing.client.end(); } catch { /* best effort */ }
    }

    const client = new Client();

    return new Promise((resolve, reject) => {
      client.on("ready", () => {
        this.connections.set(machineId, {
          client,
          machine,
          connected: true,
          lastUsedAt: Date.now(),
          reconnectAttempts: 0,
        });
        resolve();
      });

      client.on("error", (err) => {
        const errMsg = formatError(err);
        const conn = this.connections.get(machineId);
        if (conn) {
          conn.connected = false;
          conn.lastError = errMsg;
        } else {
          this.connections.set(machineId, {
            client,
            machine,
            connected: false,
            lastUsedAt: Date.now(),
            reconnectAttempts: 0,
            lastError: errMsg,
          });
        }
        reject(err);
      });

      client.on("close", () => {
        const conn = this.connections.get(machineId);
        if (conn) conn.connected = false;
      });

      const connectConfig: Record<string, unknown> = {
        host: machine.host,
        port: machine.port,
        username: machine.username,
        keepaliveInterval: 30_000,
        keepaliveCountMax: 3,
        readyTimeout: 30_000,
      };

      if (machine.authMethod === "key" && machine.keyPath) {
        try {
          connectConfig.privateKey = readFileSync(machine.keyPath);
        } catch (err) {
          return reject(new Error(`Cannot read SSH key at ${machine.keyPath}: ${formatError(err)}`));
        }
      } else if (machine.authMethod === "agent") {
        const sock = process.env.SSH_AUTH_SOCK;
        if (!sock) {
          return reject(new Error("SSH_AUTH_SOCK not set — cannot use agent auth. Start ssh-agent or use key auth."));
        }
        connectConfig.agent = sock;
      } else if (machine.authMethod === "password" && machine.password) {
        connectConfig.password = machine.password;
      }

      client.connect(connectConfig);
    });
  }

  async exec(machineId: string, command: string): Promise<ExecResult> {
    if (machineId === "local") {
      return this.execLocal(command);
    }
    const conn = await this.getConnection(machineId);
    conn.lastUsedAt = Date.now();

    return new Promise((resolve, reject) => {
      conn.client!.exec(command, (err, stream) => {
        if (err) return reject(err);

        let stdout = "";
        let stderr = "";
        let stdoutCapped = false;
        let stderrCapped = false;

        stream.on("data", (data: Buffer) => {
          if (stdoutCapped) return;
          stdout += data.toString();
          if (stdout.length > MAX_EXEC_OUTPUT) {
            stdoutCapped = true;
          }
        });
        stream.stderr.on("data", (data: Buffer) => {
          if (stderrCapped) return;
          stderr += data.toString();
          if (stderr.length > MAX_EXEC_OUTPUT) {
            stderrCapped = true;
          }
        });
        stream.on("error", (streamErr: Error) => {
          reject(streamErr);
        });
        stream.on("close", (code: number) => {
          resolve({
            stdout: capOutput(stdout, MAX_EXEC_OUTPUT),
            stderr: capOutput(stderr, MAX_EXEC_OUTPUT),
            exitCode: code ?? 0,
          });
        });
      });
    });
  }

  private execLocal(command: string, timeoutMs = 300_000): Promise<ExecResult> {
    return new Promise((resolve) => {
      cpExec(command, { maxBuffer: MAX_EXEC_OUTPUT + 1024, timeout: timeoutMs, shell: "/bin/bash" }, (err, stdout, stderr) => {
        let exitCode = 0;
        if (err) {
          // err.code can be number (exit code), string (error code like ETIMEDOUT), or null (signal kill)
          if (typeof err.code === "number") {
            exitCode = err.code;
          } else if (err.signal) {
            // Process killed by signal — report as non-zero
            exitCode = 128 + (({ SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGTERM: 15, SIGKILL: 9 } as Record<string, number>)[err.signal] ?? 1);
          } else {
            exitCode = 1;
          }
        }
        resolve({
          stdout: capOutput(stdout ?? "", MAX_EXEC_OUTPUT),
          stderr: capOutput(stderr ?? "", MAX_EXEC_OUTPUT),
          exitCode,
        });
      });
    });
  }

  async execBackground(
    machineId: string,
    command: string,
    logPath?: string,
  ): Promise<{ pid: number; logPath: string }> {
    const log = logPath ?? `/tmp/helios-${Date.now()}.log`;

    if (machineId === "local") {
      return this.execBackgroundLocal(command, log);
    }

    // Remote: use nohup + & over SSH (SSH channels close cleanly)
    // PYTHONUNBUFFERED ensures Python flushes stdout immediately for live metric capture
    // Write exit code to .exit file so we can retrieve it later (can't use `wait` from a different shell)
    const wrappedCmd = `PYTHONUNBUFFERED=1 nohup sh -c '${command.replace(/'/g, "'\\''")}; echo $? > ${log}.exit' > ${log} 2>&1 & echo $!`;
    const result = await this.exec(machineId, wrappedCmd);
    const pid = parseInt(result.stdout.trim().split("\n").pop() ?? "", 10);
    if (isNaN(pid)) {
      throw new Error(
        `Failed to get PID. stdout: ${result.stdout}, stderr: ${result.stderr}`,
      );
    }
    return { pid, logPath: log };
  }

  private execBackgroundLocal(
    command: string,
    logPath: string,
  ): Promise<{ pid: number; logPath: string }> {
    return new Promise((resolve, reject) => {
      let logFd: number | null = null;
      try {
        // Open the log file for writing
        logFd = openSync(logPath, "w");

        // Spawn detached with stdio redirected to log file
        // PYTHONUNBUFFERED ensures Python flushes stdout immediately for live metric capture
        // Wrap command to write exit code to .exit file for later retrieval
        const wrappedCommand = `${command}; echo $? > ${logPath}.exit`;
        const child = spawn("/bin/bash", ["-c", wrappedCommand], {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env: { ...process.env, PYTHONUNBUFFERED: "1" },
        });

        const pid = child.pid;
        if (pid === undefined) {
          closeSync(logFd);
          reject(new Error("Failed to spawn background process"));
          return;
        }

        // Fully detach — don't let Node wait for this child
        child.unref();
        closeSync(logFd);

        resolve({ pid, logPath });
      } catch (err) {
        if (logFd !== null) {
          try { closeSync(logFd); } catch { /* best effort */ }
        }
        reject(err);
      }
    });
  }

  async isProcessRunning(
    machineId: string,
    pid: number,
  ): Promise<boolean> {
    const result = await this.exec(
      machineId,
      `kill -0 ${pid} 2>/dev/null && echo "running" || echo "stopped"`,
    );
    return result.stdout.trim() === "running";
  }

  async tailFile(
    machineId: string,
    path: string,
    lines = 50,
  ): Promise<string> {
    const result = await this.exec(machineId, `tail -n ${lines} ${shellQuote(path)}`);
    return result.stdout;
  }

  getStatus(machineId: string): ConnectionStatus {
    const conn = this.connections.get(machineId);
    return {
      machineId,
      connected: conn?.connected ?? false,
      lastConnectedAt: conn?.lastUsedAt,
      error: conn?.lastError,
    };
  }

  getAllStatuses(): ConnectionStatus[] {
    return Array.from(this.machines.keys()).map((id) =>
      this.getStatus(id),
    );
  }

  getMachineIds(): string[] {
    return Array.from(this.machines.keys());
  }

  disconnect(machineId: string): void {
    if (machineId === "local") return;
    const conn = this.connections.get(machineId);
    if (conn) {
      conn.client?.end();
      this.connections.delete(machineId);
    }
  }

  disconnectAll(): void {
    for (const [id] of this.connections) {
      if (id !== "local") this.disconnect(id);
    }
  }

  private async getConnection(
    machineId: string,
  ): Promise<PooledConnection> {
    let conn = this.connections.get(machineId);
    if (!conn?.connected) {
      await this.connect(machineId);
      conn = this.connections.get(machineId);
    }
    if (!conn?.connected) {
      throw new Error(`Cannot connect to ${machineId}`);
    }
    return conn;
  }
}
