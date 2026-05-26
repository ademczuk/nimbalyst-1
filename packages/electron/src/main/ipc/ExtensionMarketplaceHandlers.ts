/**
 * IPC handlers for the extension marketplace.
 *
 * Provides handlers for:
 * - Fetching the extension registry from extensions.nimbalyst.com (with mock fallback)
 * - Installing extensions from the marketplace (.nimext download + extract)
 * - Installing extensions from GitHub URLs
 * - Uninstalling marketplace extensions
 * - Checking for updates
 * - Auto-updating extensions silently
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import extractZip from 'extract-zip';
import { app, BrowserWindow, net } from 'electron';
import { logger } from '../utils/logger';
import { safeHandle } from '../utils/ipcRegistry';
import {
  getUserExtensionsDirectory,
  initializeExtensionFileTypes,
  bundledExtensionsDirCandidates,
  getBundledOnlyExtensionIds,
} from './ExtensionHandlers';
import {
  getMarketplaceInstalls,
  getMarketplaceInstall,
  addMarketplaceInstall,
  removeMarketplaceInstall,
  updateMarketplaceInstall,
  type MarketplaceInstallRecord,
} from '../utils/store';

// Import mock registry data (used as fallback when live registry is unreachable)
import mockRegistry from '../data/extensionRegistry.json';

// Live registry URL -- served by the marketplace Cloudflare Worker
const REGISTRY_URL = 'https://extensions.nimbalyst.com/registry';

// Registry cache
let registryCache: RegistryData | null = null;
let registryCacheTimestamp = 0;
const REGISTRY_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes (matches Worker cache)

export interface RegistryExtension {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  categories: string[];
  tags: string[];
  icon: string;
  screenshots: Array<{ src: string; alt: string }>;
  downloads: number;
  featured: boolean;
  permissions: string[];
  minimumAppVersion: string;
  downloadUrl: string;
  checksum: string;
  repositoryUrl: string;
  changelog: string;
  /**
   * When true, this extension ships bundled with the app (not in the public
   * upstream catalog). Its `downloadUrl` uses the `bundled:<file>` scheme and
   * the package is read from the app's bundled-extensions resources. Local
   * extras are merged into the live registry so they appear in the grid.
   */
  local?: boolean;
}

export interface RegistryCategory {
  id: string;
  name: string;
  icon: string;
}

export interface RegistryData {
  schemaVersion: number;
  generatedAt: string;
  extensions: RegistryExtension[];
  categories: RegistryCategory[];
}

export interface PendingMarketplaceInstallRequest {
  extensionId: string;
  requestedAt: string;
}

interface InstallResult {
  success: boolean;
  error?: string;
  extensionId?: string;
}

let pendingMarketplaceInstallRequest: PendingMarketplaceInstallRequest | null = null;

/**
 * Merge bundled local-only extensions (e.g. gemini-cli) into a registry result
 * so they appear in the marketplace grid alongside the live upstream catalog.
 * Only entries flagged `local` in the bundled registry are merged, and only
 * when not already present in the live data.
 */
function mergeLocalExtensions(data: RegistryData): void {
  const localExtras = ((mockRegistry as RegistryData).extensions || []).filter(e => e.local);
  if (localExtras.length === 0) return;
  const haveIds = new Set((data.extensions || []).map(e => e.id));
  if (!data.extensions) data.extensions = [];
  for (const extra of localExtras) {
    if (!haveIds.has(extra.id)) data.extensions.push(extra);
  }
}

/**
 * Resolve a bundled .nimext file shipped in the app's resources. Mirrors the
 * built-in extensions directory resolution for packaged vs dev (vite build)
 * runs. Returns null if not found.
 */
async function resolveBundledNimext(fileName: string): Promise<string | null> {
  const candidates = bundledExtensionsDirCandidates().map(dir => path.join(dir, fileName));
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

// bundledExtensionsDirCandidates and getBundledOnlyExtensionIds now live in
// ExtensionHandlers.ts so both this handler and extensions:list-installed can
// share a single source of truth for what counts as a bundled marketplace-only
// extension.

/**
 * Fetch registry data from the live Cloudflare Worker.
 * Falls back to mock data if the live registry is unreachable.
 */
async function fetchRegistry(): Promise<RegistryData> {
  const now = Date.now();
  if (registryCache && (now - registryCacheTimestamp) < REGISTRY_CACHE_TTL_MS) {
    return registryCache;
  }

  try {
    const response = await net.fetch(REGISTRY_URL, {
      headers: { 'Accept': 'application/json' },
    });

    if (response.ok) {
      const data = await response.json() as RegistryData;
      mergeLocalExtensions(data);
      registryCache = data;
      registryCacheTimestamp = now;
      logger.main.info(`[ExtMarketplace] Fetched live registry: ${data.extensions?.length ?? 0} extensions`);
      return data;
    }

    logger.main.warn(`[ExtMarketplace] Live registry returned ${response.status}, using mock fallback`);
  } catch (err) {
    logger.main.warn(`[ExtMarketplace] Failed to fetch live registry, using mock fallback:`, err);
  }

  // Fallback to mock data
  registryCache = mockRegistry as RegistryData;
  registryCacheTimestamp = now;
  return registryCache;
}

/**
 * Execute a git command safely.
 */
function execGit(args: string[], options?: { cwd?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, {
      cwd: options?.cwd,
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (data) => { stdout += data.toString(); });
    proc.stderr?.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`git command failed (code ${code}): ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Recursively copy a directory.
 */
async function copyDirectory(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      // Skip .git directories
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      await copyDirectory(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

/**
 * Download a file using Electron's net module.
 * Returns the path to the downloaded temp file.
 */
async function downloadFile(url: string): Promise<string> {
  const response = await net.fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: HTTP ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const tempFile = path.join(os.tmpdir(), `nimext-${Date.now()}-${Math.random().toString(36).slice(2)}.nimext`);
  await fs.writeFile(tempFile, buffer);
  return tempFile;
}

/**
 * Verify SHA-256 checksum of a file.
 */
async function verifyChecksum(filePath: string, expectedChecksum: string): Promise<boolean> {
  if (!expectedChecksum) return true; // Skip if no checksum provided

  const fileBuffer = await fs.readFile(filePath);
  const hash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  return hash === expectedChecksum;
}

/**
 * Extract a .nimext (zip) file to a directory.
 *
 * Uses the pure-JS `extract-zip` package so this works on Windows (where there
 * is no system `unzip` binary) in addition to macOS and Linux.
 */
async function extractNimext(nimextPath: string, destPath: string): Promise<void> {
  await fs.mkdir(destPath, { recursive: true });
  await extractZip(nimextPath, { dir: destPath });
}

/**
 * Install an extension from a download URL (.nimext zip file).
 */
async function installFromUrl(
  extensionId: string,
  downloadUrl: string,
  expectedChecksum: string,
  version: string,
): Promise<InstallResult> {
  const extensionsDir = await getUserExtensionsDirectory();
  const installPath = path.join(extensionsDir, extensionId);
  let tempFile: string | null = null;
  let cleanupTemp = true;

  try {
    logger.main.info(`[ExtMarketplace] Installing extension: ${extensionId} v${version}`);

    if (!downloadUrl) {
      return { success: false, error: 'No download URL available' };
    }

    // 1. Obtain the .nimext: bundled-local (bundled:<file>) or remote download.
    if (downloadUrl.startsWith('bundled:')) {
      const fileName = downloadUrl.slice('bundled:'.length);
      const bundledPath = await resolveBundledNimext(fileName);
      if (!bundledPath) {
        return { success: false, error: `Bundled extension package not found: ${fileName}` };
      }
      logger.main.info(`[ExtMarketplace] Using bundled package: ${bundledPath}`);
      tempFile = bundledPath;
      cleanupTemp = false; // never delete the bundled source
    } else {
      logger.main.info(`[ExtMarketplace] Downloading: ${downloadUrl}`);
      tempFile = await downloadFile(downloadUrl);
    }

    // 2. Verify checksum
    if (expectedChecksum) {
      const valid = await verifyChecksum(tempFile, expectedChecksum);
      if (!valid) {
        return { success: false, error: 'Checksum verification failed. The download may be corrupted or tampered with.' };
      }
      logger.main.info(`[ExtMarketplace] Checksum verified for ${extensionId}`);
    }

    // 3. Remove existing installation if present
    try {
      await fs.rm(installPath, { recursive: true, force: true });
    } catch {
      // Not installed yet
    }

    // 4. Extract to install path
    await extractNimext(tempFile, installPath);

    // 5. Verify manifest.json exists
    const manifestPath = path.join(installPath, 'manifest.json');
    try {
      await fs.access(manifestPath);
    } catch {
      await fs.rm(installPath, { recursive: true, force: true });
      return { success: false, error: 'Invalid .nimext package: missing manifest.json' };
    }

    // 6. Track the install
    addMarketplaceInstall({
      extensionId,
      version,
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      downloadUrl,
      checksum: expectedChecksum,
      source: 'marketplace',
    });

    // 7. Re-register file types and notify renderer (with hot-reload)
    await initializeExtensionFileTypes();
    notifyExtensionsChanged(extensionId, installPath);

    logger.main.info(`[ExtMarketplace] Successfully installed ${extensionId} v${version}`);
    return { success: true, extensionId };

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.main.error(`[ExtMarketplace] Failed to install ${extensionId}:`, err);

    // Clean up partial installation
    try {
      await fs.rm(installPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }

    return { success: false, error: errorMsg };
  } finally {
    // Clean up temp file (never the bundled source).
    if (tempFile && cleanupTemp) {
      try {
        await fs.unlink(tempFile);
      } catch {
        // Ignore
      }
    }
  }
}

/**
 * Install an extension from a GitHub repository URL.
 */
async function installFromGitHub(githubUrl: string): Promise<InstallResult> {
  const extensionsDir = await getUserExtensionsDirectory();

  // Parse GitHub URL
  const match = githubUrl.match(/github\.com\/([^/]+\/[^/]+?)(?:\.git)?(?:\/tree\/[^/]+\/(.+))?(?:\/?$)/);
  if (!match) {
    return { success: false, error: `Invalid GitHub URL: ${githubUrl}` };
  }

  const [, repo, subdir] = match;
  const repoName = repo.split('/')[1];
  const tempDir = path.join(extensionsDir, `.tmp-${Date.now()}`);

  try {
    logger.main.info(`[ExtMarketplace] Installing from GitHub: ${githubUrl}`);

    // Clone the repository
    if (subdir) {
      // Sparse checkout for subdirectory
      await execGit(['clone', '--depth', '1', '--filter=blob:none', '--sparse', `https://github.com/${repo}.git`, tempDir]);
      await execGit(['sparse-checkout', 'set', subdir], { cwd: tempDir });
    } else {
      await execGit(['clone', '--depth', '1', `https://github.com/${repo}.git`, tempDir]);
    }

    // Find manifest.json
    const sourceDir = subdir ? path.join(tempDir, subdir) : tempDir;
    const manifestPath = path.join(sourceDir, 'manifest.json');

    let manifestContent: string;
    try {
      manifestContent = await fs.readFile(manifestPath, 'utf-8');
    } catch {
      return { success: false, error: 'No manifest.json found in repository. Is this a Nimbalyst extension?' };
    }

    let manifest: { id?: string; name?: string; version?: string };
    try {
      manifest = JSON.parse(manifestContent);
    } catch {
      return { success: false, error: 'Invalid manifest.json - could not parse JSON' };
    }

    if (!manifest.id) {
      return { success: false, error: 'manifest.json missing required "id" field' };
    }

    const extensionId = manifest.id;
    const installPath = path.join(extensionsDir, extensionId);

    // Check if already installed
    try {
      await fs.access(installPath);
      // Remove existing installation
      await fs.rm(installPath, { recursive: true, force: true });
    } catch {
      // Not installed yet, that's fine
    }

    // Copy to extensions directory (excluding .git and node_modules)
    await copyDirectory(sourceDir, installPath);

    // Check if there's a dist/ directory; if not, surface the error to the
    // user rather than silently registering an extension that cannot load.
    // Auto-building is intentionally deferred (slow, error-prone, runs
    // arbitrary npm scripts), so we ask the user to build locally first.
    const distPath = path.join(installPath, 'dist');
    try {
      await fs.access(distPath);
    } catch {
      const pkgJsonPath = path.join(installPath, 'package.json');
      let hasPkgJson = false;
      try {
        await fs.access(pkgJsonPath);
        hasPkgJson = true;
      } catch {
        // No package.json either - extension might be pre-built or malformed
      }

      // Clean up the partially-installed extension directory so the user
      // can retry from a fresh state.
      try {
        await fs.rm(installPath, { recursive: true, force: true });
      } catch (cleanupErr) {
        logger.main.warn(`[ExtMarketplace] Failed to clean up ${installPath} after dist/ check:`, cleanupErr);
      }

      const message = hasPkgJson
        ? `Extension repository does not include a built dist/ directory. Clone the repo locally, run "npm install && npm run build", and install from the local folder.`
        : `Extension repository does not include a dist/ directory or a package.json. The repo may be malformed or built artifacts may not be committed.`;
      logger.main.info(`[ExtMarketplace] Aborting install of ${extensionId} from GitHub: ${message}`);
      return { success: false, error: message };
    }

    // Track the install
    addMarketplaceInstall({
      extensionId,
      version: manifest.version || '0.0.0',
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      downloadUrl: '',
      checksum: '',
      source: 'github-url',
      githubUrl,
    });

    // Re-register file types and notify renderer (with hot-reload)
    await initializeExtensionFileTypes();
    notifyExtensionsChanged(extensionId, installPath);

    logger.main.info(`[ExtMarketplace] Successfully installed ${extensionId} from GitHub`);
    return { success: true, extensionId };

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.main.error(`[ExtMarketplace] Failed to install from GitHub:`, err);
    return { success: false, error: errorMsg };
  } finally {
    // Clean up temp directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Remove the given aiProvider ids from the ai-settings store. Used when an
 * extension is uninstalled so its contributed provider entries (enabled,
 * models, testStatus...) don't linger and re-populate the Settings UI on
 * the next boot. Broadcasts `ai-settings:changed` so open renderer windows
 * refresh their atoms.
 */
async function pruneAiSettingsProviders(providerIds: string[]): Promise<void> {
  if (providerIds.length === 0) return;
  const { default: Store } = await import('electron-store');
  const aiStore = new Store<Record<string, unknown>>({ name: 'ai-settings' });
  const providerSettings = (aiStore.get('providerSettings', {}) as Record<string, unknown>) ?? {};
  const removed: string[] = [];
  for (const id of providerIds) {
    if (id in providerSettings) {
      delete providerSettings[id];
      removed.push(id);
    }
  }
  if (removed.length > 0) {
    aiStore.set('providerSettings', providerSettings);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('ai-settings:changed', {
          providerIds: removed,
          apiKeyNames: [],
        });
      }
    }
  }
}

/**
 * Uninstall a marketplace-installed extension.
 */
async function uninstallExtension(extensionId: string): Promise<InstallResult> {
  const extensionsDir = await getUserExtensionsDirectory();
  const installPath = path.join(extensionsDir, extensionId);

  try {
    logger.main.info(`[ExtMarketplace] Uninstalling extension: ${extensionId}`);

    // Verify it's a marketplace install
    const record = getMarketplaceInstall(extensionId);
    if (!record) {
      return { success: false, error: `Extension ${extensionId} was not installed via marketplace` };
    }

    // BEFORE removing the directory, read the manifest to learn which
    // aiProviders the extension contributed. We need this list to garbage-
    // collect the matching keys from ai-settings.providerSettings -- without
    // this step, the user's stored enabled/models choices persist on disk
    // forever and the renderer SettingsSidebar keeps rendering ghost provider
    // rows on the next boot even though no extension is registered.
    let contributedAiProviderIds: string[] = [];
    try {
      const manifestPath = path.join(installPath, 'manifest.json');
      const manifestRaw = await fs.readFile(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestRaw) as {
        contributions?: { aiProviders?: Array<{ id?: string }> };
      };
      contributedAiProviderIds = (manifest.contributions?.aiProviders ?? [])
        .map((p) => p?.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
    } catch (err) {
      logger.main.warn(
        `[ExtMarketplace] Could not read manifest for ${extensionId} ` +
        `before uninstall; skipping ai-settings cleanup: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Remove the extension directory
    try {
      await fs.rm(installPath, { recursive: true, force: true });
    } catch (err) {
      logger.main.warn(`[ExtMarketplace] Could not remove extension directory: ${err}`);
    }

    // Remove from tracking
    removeMarketplaceInstall(extensionId);

    // Re-register file types and notify renderer (with unload)
    await initializeExtensionFileTypes();
    notifyExtensionUnloaded(extensionId);

    // Garbage-collect provider entries the uninstalled extension contributed
    // to ai-settings. Done AFTER notifyExtensionUnloaded so the renderer's
    // ProviderRegistry.unregister fires before the broadcast that follows.
    if (contributedAiProviderIds.length > 0) {
      try {
        await pruneAiSettingsProviders(contributedAiProviderIds);
        logger.main.info(
          `[ExtMarketplace] Pruned ${contributedAiProviderIds.length} aiProvider entry(ies) ` +
          `from ai-settings for ${extensionId}: ${contributedAiProviderIds.join(', ')}`,
        );
      } catch (err) {
        logger.main.warn(
          `[ExtMarketplace] Failed to prune ai-settings for ${extensionId}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    logger.main.info(`[ExtMarketplace] Successfully uninstalled ${extensionId}`);
    return { success: true, extensionId };

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.main.error(`[ExtMarketplace] Failed to uninstall ${extensionId}:`, err);
    return { success: false, error: errorMsg };
  }
}

/**
 * Check for available updates by comparing installed versions against registry.
 */
async function checkForUpdates(): Promise<Array<{ extensionId: string; currentVersion: string; availableVersion: string }>> {
  const registry = await fetchRegistry();
  const installs = getMarketplaceInstalls();
  const updates: Array<{ extensionId: string; currentVersion: string; availableVersion: string }> = [];

  for (const [extensionId, record] of Object.entries(installs)) {
    const registryEntry = registry.extensions.find(e => e.id === extensionId);
    if (registryEntry && registryEntry.version !== record.version) {
      // Simple string comparison for now. Could use semver later.
      updates.push({
        extensionId,
        currentVersion: record.version,
        availableVersion: registryEntry.version,
      });
    }
  }

  return updates;
}

/**
 * Send IPC event to all renderer windows that extensions have changed.
 * If extensionId and extensionPath are provided, also triggers a hot-reload
 * so the renderer loads the new extension without requiring a page refresh.
 */
function notifyExtensionsChanged(extensionId?: string, extensionPath?: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('extensions:list-changed');
      // Trigger renderer-side extension loading via the existing dev-reload mechanism
      if (extensionId && extensionPath) {
        win.webContents.send('extension:dev-reload', { extensionId, extensionPath });
      }
    }
  }
}

/**
 * Send IPC event to all renderer windows to unload an extension.
 */
function notifyExtensionUnloaded(extensionId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('extensions:list-changed');
      win.webContents.send('extension:dev-unload', { extensionId });
    }
  }
}

export function queueMarketplaceInstallRequest(extensionId: string): void {
  pendingMarketplaceInstallRequest = {
    extensionId,
    requestedAt: new Date().toISOString(),
  };

  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send('extension-marketplace:install-request', pendingMarketplaceInstallRequest);
    }
  }
}

/**
 * Reconcile the marketplace-installs electron-store entries against the actual
 * contents of the user extensions dir. If an entry is tracked but its
 * extension directory is missing (e.g. the user deleted it by hand outside
 * the UI), prune the stale entry. Returns the reconciled installs map.
 *
 * This is the source of truth for what counts as "installed via marketplace":
 * the tracking record AND the on-disk directory. Either one missing means
 * not installed.
 */
export async function reconcileMarketplaceInstallsWithDisk(): Promise<Record<string, MarketplaceInstallRecord>> {
  const installs = getMarketplaceInstalls();
  const ids = Object.keys(installs);
  if (ids.length === 0) return installs;

  const extensionsDir = await getUserExtensionsDirectory();
  const pruned: string[] = [];

  for (const extensionId of ids) {
    const installPath = path.join(extensionsDir, extensionId);
    try {
      const stat = await fs.stat(installPath);
      if (!stat.isDirectory()) {
        pruned.push(extensionId);
        continue;
      }
      // Also require a manifest.json -- a bare directory without a manifest
      // would have failed to load anyway.
      try {
        await fs.access(path.join(installPath, 'manifest.json'));
      } catch {
        pruned.push(extensionId);
      }
    } catch {
      // Directory does not exist -- the user deleted it out of band.
      pruned.push(extensionId);
    }
  }

  if (pruned.length === 0) return installs;

  for (const extensionId of pruned) {
    delete installs[extensionId];
    removeMarketplaceInstall(extensionId);
    logger.main.info(`[ExtMarketplace] Pruned stale marketplace install record for ${extensionId} (directory missing from user extensions dir)`);
  }

  return installs;
}

/**
 * Silently check for and apply extension updates.
 * Intended to be called once on app startup (fire-and-forget).
 *
 * Also reconciles marketplace install tracking against disk before checking
 * for updates so we don't try to "update" an extension the user has already
 * deleted out of band.
 */
export async function runExtensionAutoUpdate(): Promise<void> {
  try {
    await reconcileMarketplaceInstallsWithDisk();
  } catch (err) {
    logger.main.warn('[ExtMarketplace] Install reconciliation failed:', err);
  }

  try {
    const updates = await checkForUpdates();
    if (updates.length === 0) return;

    const registry = await fetchRegistry();
    for (const update of updates) {
      const entry = registry.extensions.find(e => e.id === update.extensionId);
      if (!entry?.downloadUrl) continue;

      const result = await installFromUrl(update.extensionId, entry.downloadUrl, entry.checksum, entry.version);
      if (result.success) {
        logger.main.info(`[ExtMarketplace] Auto-updated ${update.extensionId}: ${update.currentVersion} -> ${update.availableVersion}`);
      }
    }
  } catch (err) {
    logger.main.warn('[ExtMarketplace] Auto-update check failed:', err);
  }
}

/**
 * Register all marketplace IPC handlers.
 */
export function registerExtensionMarketplaceHandlers(): void {
  // Fetch registry
  safeHandle('extension-marketplace:fetch-registry', async () => {
    try {
      const data = await fetchRegistry();
      return { success: true, data };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.main.error('[ExtMarketplace] Failed to fetch registry:', error);
      return { success: false, error: message };
    }
  });

  // Get marketplace-installed extensions
  //
  // Reconciles the electron-store tracking against the actual user extensions
  // dir on every call so the renderer never sees a ghost entry left behind by
  // an out-of-band directory delete. Cheap: O(installed-count) fs.stat calls.
  safeHandle('extension-marketplace:get-installed', async () => {
    try {
      const installs = await reconcileMarketplaceInstallsWithDisk();
      return { success: true, data: installs };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
  });

  safeHandle('extension-marketplace:consume-pending-install-request', async () => {
    const request = pendingMarketplaceInstallRequest;
    pendingMarketplaceInstallRequest = null;
    return { success: true, data: request };
  });

  // Install from marketplace (download URL)
  safeHandle('extension-marketplace:install', async (_event, extensionId: string, downloadUrl: string, checksum: string, version: string) => {
    if (!extensionId) {
      return { success: false, error: 'Extension ID is required' };
    }
    return await installFromUrl(extensionId, downloadUrl, checksum, version);
  });

  // Install from GitHub URL
  safeHandle('extension-marketplace:install-from-github', async (_event, githubUrl: string) => {
    if (!githubUrl) {
      return { success: false, error: 'GitHub URL is required' };
    }
    return await installFromGitHub(githubUrl);
  });

  // Uninstall extension
  safeHandle('extension-marketplace:uninstall', async (_event, extensionId: string) => {
    if (!extensionId) {
      return { success: false, error: 'Extension ID is required' };
    }
    return await uninstallExtension(extensionId);
  });

  // Check for updates
  safeHandle('extension-marketplace:check-updates', async () => {
    try {
      const updates = await checkForUpdates();
      return { success: true, data: updates };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: message };
    }
  });

  // Auto-update: silently update all extensions with available updates
  safeHandle('extension-marketplace:auto-update', async () => {
    try {
      const updates = await checkForUpdates();
      if (updates.length === 0) {
        return { success: true, data: { updated: [] } };
      }

      const registry = await fetchRegistry();
      const updated: Array<{ extensionId: string; fromVersion: string; toVersion: string }> = [];

      for (const update of updates) {
        const registryEntry = registry.extensions.find(e => e.id === update.extensionId);
        if (!registryEntry || !registryEntry.downloadUrl) continue;

        const result = await installFromUrl(
          update.extensionId,
          registryEntry.downloadUrl,
          registryEntry.checksum,
          registryEntry.version,
        );

        if (result.success) {
          updated.push({
            extensionId: update.extensionId,
            fromVersion: update.currentVersion,
            toVersion: update.availableVersion,
          });
        }
      }

      if (updated.length > 0) {
        logger.main.info(`[ExtMarketplace] Auto-updated ${updated.length} extensions`);
      }

      return { success: true, data: { updated } };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.main.error('[ExtMarketplace] Auto-update failed:', error);
      return { success: false, error: message };
    }
  });

  // Clear cache
  safeHandle('extension-marketplace:clear-cache', async () => {
    registryCache = null;
    registryCacheTimestamp = 0;
    return { success: true };
  });

  // List the extension IDs that ship as bundled .nimext packages. The
  // renderer extension loader uses this to skip auto-discovery of those
  // extensions from the BUILT-IN extensions directory, so they only load
  // when the user explicitly installs them via the Marketplace.
  safeHandle('extensions:get-bundled-only-ids', async () => {
    try {
      const ids = await getBundledOnlyExtensionIds();
      return { success: true, data: ids };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.main.warn('[ExtMarketplace] Failed to list bundled-only extension IDs:', error);
      return { success: false, error: message };
    }
  });
}
