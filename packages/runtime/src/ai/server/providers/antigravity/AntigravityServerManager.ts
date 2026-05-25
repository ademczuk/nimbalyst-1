/**
 * AntigravityServerManager
 *
 * Owns the lifecycle of the Antigravity language server (a Codeium/Windsurf "exa"
 * Connect-RPC server) and exposes a typed RPC surface to it. Backs the
 * `antigravity-gemini` chat provider.
 *
 * Two modes, auto-selected by ensureRunning():
 *   A. Attach to a running Antigravity "hub" language server (the user's IDE is open).
 *   B. Spawn and manage our own standalone hub server (IDE closed / not installed UI).
 *
 * Auth is the user's existing Antigravity/Google login in ~/.gemini. The server
 * reads and refreshes that token itself (the on-disk access_token can be expired;
 * it refreshes in-memory via the refresh_token). nimbalyst stores no API key and
 * never triggers a browser OAuth (per the project's no-env-key rule).
 *
 * Proven transport (see nimbalyst-local/agy-standalone-approachB.md):
 *   POST https://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/<Method>
 *   header x-codeium-csrf-token: <csrf>
 *   GetModelResponse body {prompt, model:<enum>} -> {response}
 *
 * Singleton-per-process: use AntigravityServerManager.shared().
 */
import { spawn, ChildProcess, execFile } from 'child_process';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { randomUUID } from 'crypto';

const SERVICE = 'exa.language_server_pb.LanguageServerService';

// IDE version to advertise. REQUIRED: without it the backend rejects the build with
// "This version of Antigravity is no longer supported." Keep in sync with the IDE.
const OVERRIDE_IDE_VERSION = '2.0.6';

// Default standalone-spawn port. Must avoid Windows excluded TCP ranges
// (netsh int ipv4 show excludedportrange protocol=tcp). 51717 is clear; the
// 50000-50600 / 52649-52848 ranges are reserved on a typical Windows setup.
const DEFAULT_SPAWN_PORT = 51717;

export interface AntigravityEndpoint {
  httpsPort: number;
  csrf: string;
  /** true when we spawned this server ourselves (mode B); false when attached (mode A). */
  owned: boolean;
}

export interface AntigravityModelInfo {
  /** Stable key, e.g. "gemini-3-flash-agent". */
  key: string;
  /** Server-assigned enum, e.g. "MODEL_PLACEHOLDER_M133". NOT stable across builds. */
  enum: string;
  /** Human label, e.g. "Gemini 3.5 Flash (High)". */
  displayName: string;
  apiProvider?: string;
  maxTokens?: number;
}

export class AntigravityVersionGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AntigravityVersionGateError';
  }
}

export class AntigravityServerManager {
  private static instance: AntigravityServerManager | null = null;

  private endpoint: AntigravityEndpoint | null = null;
  private child: ChildProcess | null = null;
  private startPromise: Promise<AntigravityEndpoint> | null = null;
  /** Cache of key -> enum, valid for the current endpoint only. */
  private enumCache = new Map<string, string>();

  static shared(): AntigravityServerManager {
    if (!this.instance) this.instance = new AntigravityServerManager();
    return this.instance;
  }

  /** Resolve the language_server.exe path for the current platform. */
  static binaryPath(): string {
    if (process.platform === 'win32') {
      const local = process.env.LOCALAPPDATA
        || path.join(os.homedir(), 'AppData', 'Local');
      return path.join(local, 'Programs', 'Antigravity', 'resources', 'bin',
        'language_server.exe');
    }
    if (process.platform === 'darwin') {
      // The macOS app bundles the server under the app's Resources.
      return '/Applications/Antigravity.app/Contents/Resources/bin/language_server';
    }
    // Linux
    return path.join(os.homedir(), '.local', 'share', 'antigravity', 'bin',
      'language_server');
  }

  /** True if the Antigravity install (the language server binary) is present. */
  static isInstalled(): boolean {
    try {
      return fs.existsSync(this.binaryPath());
    } catch {
      return false;
    }
  }

  /** True if ~/.gemini has an OAuth credential with a refresh token. */
  static hasGeminiAuth(): boolean {
    try {
      const p = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
      if (!fs.existsSync(p)) return false;
      const creds = JSON.parse(fs.readFileSync(p, 'utf8'));
      return Boolean(creds && creds.refresh_token);
    } catch {
      return false;
    }
  }

  /**
   * Ensure a usable server endpoint exists. Attaches to a running hub if present,
   * otherwise spawns our own. Idempotent and concurrency-safe.
   */
  async ensureRunning(): Promise<AntigravityEndpoint> {
    if (this.endpoint && (await this.isHealthy(this.endpoint))) {
      return this.endpoint;
    }
    if (this.startPromise) return this.startPromise;

    this.startPromise = (async () => {
      // Reset stale state.
      this.endpoint = null;
      this.enumCache.clear();

      // Mode A: attach to a running hub (IDE open) to avoid a second process.
      const attached = await this.discoverRunningHub();
      if (attached) {
        this.endpoint = attached;
        return attached;
      }

      // Mode B: spawn our own standalone hub.
      const spawned = await this.spawnStandalone();
      this.endpoint = spawned;
      return spawned;
    })();

    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  /** Stop the server if we own it. No-op when attached to the IDE's hub. */
  stop(): void {
    if (this.child && !this.child.killed) {
      try {
        this.child.kill();
      } catch {
        /* best effort */
      }
    }
    this.child = null;
    this.endpoint = null;
    this.enumCache.clear();
  }

  // ---- RPC ---------------------------------------------------------------

  /** Low-level Connect-RPC POST returning parsed JSON. */
  private rpc<T = any>(method: string, body: unknown, ep: AntigravityEndpoint,
    timeoutMs = 120_000): Promise<T> {
    const payload = Buffer.from(JSON.stringify(body));
    return new Promise<T>((resolve, reject) => {
      const req = https.request(
        {
          host: '127.0.0.1',
          port: ep.httpsPort,
          path: `/${SERVICE}/${method}`,
          method: 'POST',
          // The server uses a self-signed cert on localhost.
          rejectUnauthorized: false,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': payload.length,
            'x-codeium-csrf-token': ep.csrf,
          },
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if ((res.statusCode ?? 0) >= 400) {
              reject(new Error(
                `Antigravity ${method} HTTP ${res.statusCode}: ${text.slice(0, 300)}`));
              return;
            }
            try {
              resolve(JSON.parse(text) as T);
            } catch (e) {
              reject(new Error(`Antigravity ${method} bad JSON: ${text.slice(0, 200)}`));
            }
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error(`Antigravity ${method} timed out`)));
      req.on('error', reject);
      req.write(payload);
      req.end();
    });
  }

  /**
   * Send a one-shot prompt to a model identified by its stable KEY (preferred) or
   * an enum. Returns the model's text response.
   *
   * Resolves the key to the server's current enum first (the enum is not stable
   * across builds). Guards against the version-gate response.
   */
  async getModelResponse(prompt: string, modelKeyOrEnum: string,
    timeoutMs = 120_000): Promise<string> {
    const ep = await this.ensureRunning();
    const enumName = modelKeyOrEnum.startsWith('MODEL_')
      ? modelKeyOrEnum
      : await this.resolveModelEnum(modelKeyOrEnum, ep);
    const res = await this.rpc<{ response?: string }>(
      'GetModelResponse', { prompt, model: enumName }, ep, timeoutMs);
    const text = res.response ?? '';
    if (typeof text === 'string' && text.includes('no longer supported')) {
      throw new AntigravityVersionGateError(
        `Antigravity backend rejected the build (version gate). Server must run with ` +
        `--override_ide_version ${OVERRIDE_IDE_VERSION}. Got: ${text}`);
    }
    return text;
  }

  /** Full model catalog as {key -> info}. */
  async getAvailableModels(ep?: AntigravityEndpoint): Promise<Map<string, AntigravityModelInfo>> {
    const endpoint = ep ?? (await this.ensureRunning());
    const data = await this.rpc<{ response?: { models?: Record<string, any> } }>(
      'GetAvailableModels', {}, endpoint, 30_000);
    const models = data.response?.models ?? {};
    const out = new Map<string, AntigravityModelInfo>();
    for (const [key, v] of Object.entries(models)) {
      out.set(key, {
        key,
        enum: v.model,
        displayName: v.displayName ?? v.label ?? '',
        apiProvider: v.apiProvider,
        maxTokens: v.maxTokens,
      });
    }
    return out;
  }

  /**
   * Resolve a stable model KEY (or displayName) to the server's current enum.
   * Cached per endpoint. Throws if not found.
   */
  async resolveModelEnum(keyOrDisplayName: string, ep?: AntigravityEndpoint): Promise<string> {
    const cached = this.enumCache.get(keyOrDisplayName);
    if (cached) return cached;
    const endpoint = ep ?? (await this.ensureRunning());
    const catalog = await this.getAvailableModels(endpoint);

    // direct key hit
    const byKey = catalog.get(keyOrDisplayName);
    if (byKey?.enum) {
      this.enumCache.set(keyOrDisplayName, byKey.enum);
      return byKey.enum;
    }
    // displayName match (case-insensitive)
    for (const info of catalog.values()) {
      if (info.displayName.toLowerCase() === keyOrDisplayName.toLowerCase() && info.enum) {
        this.enumCache.set(keyOrDisplayName, info.enum);
        return info.enum;
      }
    }
    throw new Error(
      `Antigravity model ${keyOrDisplayName} not found; available keys: ` +
      `${[...catalog.keys()].join(', ')}`);
  }

  /** Raw GetUserStatus (used by the usage meter). */
  async getUserStatus(ep?: AntigravityEndpoint): Promise<any> {
    const endpoint = ep ?? (await this.ensureRunning());
    const data = await this.rpc<{ userStatus?: any }>('GetUserStatus', {}, endpoint, 15_000);
    return data.userStatus ?? {};
  }

  // ---- mode A: discover a running hub ------------------------------------

  /**
   * Find a running Antigravity "hub" language server (the user's IDE) and return
   * its endpoint, or null. Windows-only discovery via the process table; on other
   * platforms returns null (we spawn our own).
   */
  private async discoverRunningHub(): Promise<AntigravityEndpoint | null> {
    if (process.platform !== 'win32') return null;
    const ps =
      `$p = Get-CimInstance Win32_Process -Filter 'Name="language_server.exe"' | ` +
      `Where-Object { $_.CommandLine -match '--subclient_type hub' } | Select-Object -First 1; ` +
      `if (-not $p) { Write-Output 'NONE'; exit } ` +
      `$csrf = if ($p.CommandLine -match '--csrf_token (\\S+)') { $matches[1] } else { '' }; ` +
      `$ports = Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue | ` +
      `Select-Object -ExpandProperty LocalPort | Sort-Object; ` +
      `Write-Output ($csrf + '|' + ($ports -join ','))`;
    const out = await this.runPowerShell(ps).catch(() => '');
    const line = out.trim();
    if (!line || line === 'NONE') return null;
    const [csrf, ports] = line.split('|');
    const portList = (ports || '').split(',').map((x) => parseInt(x, 10)).filter(Boolean);
    if (!csrf || portList.length === 0) return null;
    // Lower port = HTTPS, higher = HTTP.
    const httpsPort = Math.min(...portList);
    const ep: AntigravityEndpoint = { httpsPort, csrf, owned: false };
    return (await this.isHealthy(ep)) ? ep : null;
  }

  // ---- mode B: spawn our own --------------------------------------------

  private async spawnStandalone(): Promise<AntigravityEndpoint> {
    const binary = AntigravityServerManager.binaryPath();
    if (!fs.existsSync(binary)) {
      throw new Error(
        `Antigravity language server not found at ${binary}. Install Antigravity or ` +
        `open the Antigravity IDE.`);
    }
    if (!AntigravityServerManager.hasGeminiAuth()) {
      throw new Error(
        `No Antigravity/Gemini login found in ~/.gemini. Sign in via the Antigravity ` +
        `IDE first (nimbalyst does not perform the OAuth browser flow).`);
    }

    const csrf = `nimbalyst-${randomUUID()}`;
    const port = DEFAULT_SPAWN_PORT;
    const args = [
      '--standalone',
      '--subclient_type', 'hub',
      '--override_ide_name', 'antigravity',
      '--override_ide_version', OVERRIDE_IDE_VERSION, // REQUIRED: avoids version gate
      '--override_user_agent_name', 'antigravity',
      '--api_server_url', 'https://generativelanguage.googleapis.com',
      '--cloud_code_endpoint', 'https://daily-cloudcode-pa.googleapis.com',
      '--csrf_token', csrf,
      '--https_server_port', String(port),
      '--app_data_dir', 'antigravity',
      '--enable_sidecars',
    ];
    const child = spawn(binary, args, {
      stdio: 'ignore',
      detached: false,
      windowsHide: true,
    });
    this.child = child;
    child.on('exit', () => {
      // If our owned server dies, drop the endpoint so the next call respawns.
      if (this.child === child) {
        this.child = null;
        this.endpoint = null;
        this.enumCache.clear();
      }
    });

    const ep: AntigravityEndpoint = { httpsPort: port, csrf, owned: true };
    // Poll Heartbeat until the server binds (observed ~2s).
    const deadline = Date.now() + 60_000;
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(`Antigravity server exited early (code ${child.exitCode})`);
      }
      if (await this.isHealthy(ep)) return ep;
      lastErr = 'not bound yet';
      await delay(500);
    }
    this.stop();
    throw new Error(`Antigravity server did not bind within 60s (${String(lastErr)})`);
  }

  // ---- helpers -----------------------------------------------------------

  private async isHealthy(ep: AntigravityEndpoint): Promise<boolean> {
    try {
      await this.rpc('Heartbeat', {}, ep, 4_000);
      return true;
    } catch {
      return false;
    }
  }

  private runPowerShell(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'powershell',
        ['-NoProfile', '-Command', script],
        { timeout: 30_000, windowsHide: true },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
