/**
 * IPC handlers for extension-related operations.
 *
 * Provides handlers for:
 * - Getting the extensions directory
 * - Reading extension files
 * - Loading extension modules
 * - Directory listing
 */

import { app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../utils/logger';
import { safeHandle, safeOn } from '../utils/ipcRegistry';
import { SessionFileWatcher } from '../file/SessionFileWatcher';
import { minimatch } from 'minimatch';
import {
  getExtensionSettings,
  getExtensionEnabled,
  setExtensionEnabled,
  getClaudePluginEnabled,
  setClaudePluginEnabled,
  getAgentWorkflowsEnabled,
  setAgentWorkflowsEnabled,
  getExtensionConfiguration,
  setExtensionConfiguration,
  setExtensionConfigurationBulk,
  getWorkspaceExtensionConfiguration,
  setWorkspaceExtensionConfiguration,
  setWorkspaceExtensionConfigurationBulk,
  getReleaseChannel,
} from '../utils/store';
import { registerFileExtension, clearRegisteredExtensions } from '../extensions/RegisteredFileTypes';
import type { ReleaseChannel } from '../utils/store';
import { buildExtensionFindFilesPlan } from './extensionFindFilesPlan';
import { getEnhancedPath } from '../services/CLIManager';
import type { ChildProcess } from 'child_process';

/**
 * Tracks live child processes spawned via the extension:spawn streaming bridge.
 * Keyed by a generated handleId. senderId binds the handle to the renderer
 * (webContents.id) that created it, so write/kill can only touch their own
 * processes. Lazily initialized inside registerExtensionHandlers.
 */
interface SpawnedProcessEntry {
  child: ChildProcess;
  extensionId: string;
  senderId: number;
}
let spawnedProcesses: Map<string, SpawnedProcessEntry> | undefined;

/**
 * Check if an extension should be visible for the current release channel.
 * Extensions with requiredReleaseChannel: 'alpha' are only visible to alpha users.
 * Extensions without this field or with 'stable' are visible to everyone.
 */
function isExtensionVisibleForChannel(
  manifest: { requiredReleaseChannel?: ReleaseChannel },
  currentChannel: ReleaseChannel
): boolean {
  const requiredChannel = manifest.requiredReleaseChannel;

  // No requirement or 'stable' requirement = visible to everyone
  if (!requiredChannel || requiredChannel === 'stable') {
    return true;
  }

  // 'alpha' requirement = only visible to alpha users
  if (requiredChannel === 'alpha') {
    return currentChannel === 'alpha';
  }

  // Unknown channel requirement = default to visible (fail open)
  return true;
}

/**
 * Initialize extension file type registry.
 * Should be called during app startup to ensure file types are registered
 * before any file operations occur.
 */
export async function initializeExtensionFileTypes(): Promise<void> {
  try {
    logger.main.info('[ExtensionHandlers] Initializing extension file types...');
    clearRegisteredExtensions();

    const extensionDirs = await getAllExtensionDirectories();
    const currentChannel = getReleaseChannel();

    for (const extensionsDir of extensionDirs) {
      let subdirs;
      try {
        subdirs = await fs.readdir(extensionsDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const subdir of subdirs) {
        let isDir = subdir.isDirectory();
        if (!isDir && subdir.isSymbolicLink()) {
          try {
            const targetPath = path.join(extensionsDir, subdir.name);
            const stat = await fs.stat(targetPath);
            isDir = stat.isDirectory();
          } catch {
            continue;
          }
        }
        if (!isDir) continue;

        const extensionPath = path.join(extensionsDir, subdir.name);
        const manifestPath = path.join(extensionPath, 'manifest.json');

        try {
          const manifestContent = await fs.readFile(manifestPath, 'utf-8');
          const manifest = JSON.parse(manifestContent);

          // Skip extensions that require a different release channel
          if (!isExtensionVisibleForChannel(manifest, currentChannel)) {
            logger.main.debug(`[ExtensionHandlers] Skipping extension ${manifest.id} (requires ${manifest.requiredReleaseChannel} channel)`);
            continue;
          }

          // Register file patterns from customEditors
          if (manifest.contributions?.customEditors) {
            for (const editor of manifest.contributions.customEditors) {
              if (editor.filePatterns) {
                for (const pattern of editor.filePatterns) {
                  if (pattern.startsWith('*.')) {
                    const ext = pattern.substring(1);
                    registerFileExtension(ext);
                    logger.main.info(`[ExtensionHandlers] Registered file type: ${ext} (from ${manifest.id})`);
                  }
                }
              }
            }
          }
        } catch {
          // Skip directories without valid manifest
        }
      }
    }

    logger.main.info('[ExtensionHandlers] Extension file types initialized');
  } catch (error) {
    logger.main.error('[ExtensionHandlers] Failed to initialize extension file types:', error);
  }
}

/**
 * Get the path to the user extensions directory.
 * Creates it if it doesn't exist.
 * In Playwright tests, uses a temp directory to avoid touching production extensions.
 */
export async function getUserExtensionsDirectory(): Promise<string> {
  // Use test-specific path for Playwright tests to avoid conflicts
  const userDataPath = process.env.PLAYWRIGHT === '1'
    ? path.join(app.getPath('temp'), 'nimbalyst-test-extensions')
    : app.getPath('userData');
  const extensionsPath = path.join(userDataPath, 'extensions');

  try {
    await fs.mkdir(extensionsPath, { recursive: true });
  } catch (error) {
    // Directory already exists or other error
    logger.main.debug('[ExtensionHandlers] User extensions directory:', extensionsPath);
  }

  return extensionsPath;
}

/**
 * Get the path to the built-in extensions directory.
 * Returns null if the directory doesn't exist.
 */
async function getBuiltinExtensionsDirectory(): Promise<string | null> {
  // In production, built-in extensions are in resources/extensions
  // In development, they're in packages/extensions relative to the electron package
  const possiblePaths = app.isPackaged
    ? [
        path.join(process.resourcesPath, 'extensions'),
        path.join(process.resourcesPath, 'app.asar.unpacked', 'extensions'),
      ]
    : [
        // Development: relative to __dirname (out/main/chunks in vite build)
        // Go up 4 levels to packages/, then into extensions/
        path.join(__dirname, '..', '..', '..', '..', 'extensions'),
        // Fallback: if __dirname is out/main (no chunks)
        path.join(__dirname, '..', '..', '..', 'extensions'),
        path.join(__dirname, '..', '..', 'resources', 'extensions'),
      ];

  for (const possiblePath of possiblePaths) {
    try {
      await fs.access(possiblePath);
      logger.main.debug('[ExtensionHandlers] Built-in extensions directory:', possiblePath);
      return possiblePath;
    } catch {
      // Path doesn't exist, try next
    }
  }

  logger.main.debug('[ExtensionHandlers] No built-in extensions directory found');
  return null;
}

/**
 * Get all extension directories (both user and built-in).
 *
 * CONTRACT: The USER extensions directory is always the FIRST entry.
 * Renderer's ExtensionLoader.discoverExtensions relies on this ordering to
 * (a) let user-installed copies win on ID conflicts and (b) skip bundled
 * MARKETPLACE-ONLY extensions when scanning built-in dirs (see
 * `extensions:get-bundled-only-ids` and `getBundledOnlyExtensionIds`).
 *
 * Bundled .nimext packages (e.g. gemini-cli, gemini-antigravity) ship in
 * `resources/bundled-extensions/` and appear as INSTALLABLE in the Marketplace
 * grid. They do NOT auto-load from the built-in extensions directory; the
 * user must explicitly install them via Marketplace, which copies the
 * .nimext into the user dir (where it then loads normally). This prevents
 * marketplace extensions from appearing pre-installed simply because the
 * development checkout has a sibling source folder under `packages/extensions/`.
 */
export async function getAllExtensionDirectories(): Promise<string[]> {
  const dirs: string[] = [];

  // Always include user extensions directory FIRST so it wins on ID conflicts.
  dirs.push(await getUserExtensionsDirectory());

  // Include built-in extensions if available
  const builtinDir = await getBuiltinExtensionsDirectory();
  if (builtinDir) {
    dirs.push(builtinDir);
  }

  return dirs;
}

/**
 * Candidate directories where the app's bundled .nimext packages live.
 * Mirrors `getBuiltinExtensionsDirectory` resolution for packaged vs dev
 * (vite build) runs. Used by `getBundledOnlyExtensionIds` and by the
 * marketplace handler to resolve the actual .nimext file at install time.
 */
export function bundledExtensionsDirCandidates(): string[] {
  return app.isPackaged
    ? [
        path.join(process.resourcesPath, 'bundled-extensions'),
        path.join(process.resourcesPath, 'app.asar.unpacked', 'bundled-extensions'),
      ]
    : [
        // __dirname is out/main or out/main/chunks; resources is at packages/electron/resources
        path.join(__dirname, '..', '..', 'resources', 'bundled-extensions'),
        path.join(__dirname, '..', '..', '..', 'resources', 'bundled-extensions'),
        path.join(__dirname, '..', '..', '..', '..', 'electron', 'resources', 'bundled-extensions'),
      ];
}

/**
 * Compute the set of extension IDs that ship as bundled .nimext packages in
 * `resources/bundled-extensions/`. These are MARKETPLACE-ONLY: they appear in
 * the marketplace and install into the USER extensions dir on explicit user
 * action. They must NOT be auto-discovered out of the BUILT-IN extensions dir
 * even if a development checkout has a sibling source folder under
 * `packages/extensions/` (which happens for in-tree development of marketplace
 * extensions). User-installed copies in the user extensions dir still load
 * normally.
 *
 * The ID is derived from the .nimext filename: `gemini-antigravity.nimext` ->
 * `gemini-antigravity`. The bundled registry (`extensionRegistry.json`) keeps
 * the same naming convention via `downloadUrl: "bundled:<id>.nimext"`.
 */
export async function getBundledOnlyExtensionIds(): Promise<string[]> {
  const ids = new Set<string>();
  for (const dir of bundledExtensionsDirCandidates()) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.toLowerCase().endsWith('.nimext')) {
        ids.add(entry.slice(0, -'.nimext'.length));
      }
    }
  }
  return Array.from(ids);
}

/**
 * Look up an installed extension's manifest by its declared id, scanning all
 * extension directories (user + built-in). Returns the parsed manifest, or
 * null if no installed extension declares that id.
 *
 * NOTE: the id is supplied by the renderer and is therefore spoofable. This
 * lookup at least guarantees the spawn/exec only proceeds for an id that maps
 * to a real installed manifest carrying the required permission. Binding the
 * sender's webContents to a specific extension is a larger change owned by the
 * extension-loader; tracked as a TODO at the spawn handler.
 */
async function findExtensionManifestById(extensionId: string): Promise<Record<string, unknown> | null> {
  const extensionDirs = await getAllExtensionDirectories();
  for (const extDir of extensionDirs) {
    let subdirs;
    try {
      subdirs = await fs.readdir(extDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const subdir of subdirs) {
      let isDir = subdir.isDirectory();
      if (!isDir && subdir.isSymbolicLink()) {
        try {
          const stat = await fs.stat(path.join(extDir, subdir.name));
          isDir = stat.isDirectory();
        } catch { continue; }
      }
      if (!isDir) continue;
      const manifestPath = path.join(extDir, subdir.name, 'manifest.json');
      try {
        const manifestJson = await fs.readFile(manifestPath, 'utf-8');
        const manifest = JSON.parse(manifestJson) as Record<string, unknown>;
        if (manifest.id === extensionId) {
          return manifest;
        }
      } catch { continue; }
    }
  }
  return null;
}

/**
 * Return type for extension plugin commands
 */
export interface ExtensionPluginCommand {
  extensionId: string;
  extensionName: string;
  pluginName: string;
  pluginNamespace: string;
  commandName: string;
  description: string;
}

/**
 * Get Claude plugin commands from all enabled extensions.
 * Exported for use by SlashCommandHandlers.
 */
export async function getExtensionPluginCommands(): Promise<ExtensionPluginCommand[]> {
  try {
    const commands: ExtensionPluginCommand[] = [];
    const seenExtensionIds = new Set<string>();
    const currentChannel = getReleaseChannel();

    // Scan all extension directories
    const extensionDirs = await getAllExtensionDirectories();

    for (const extensionsDir of extensionDirs) {
      let subdirs;
      try {
        subdirs = await fs.readdir(extensionsDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const subdir of subdirs) {
        let isDir = subdir.isDirectory();
        if (!isDir && subdir.isSymbolicLink()) {
          try {
            const targetPath = path.join(extensionsDir, subdir.name);
            const stat = await fs.stat(targetPath);
            isDir = stat.isDirectory();
          } catch {
            continue;
          }
        }
        if (!isDir) continue;

        const extensionPath = path.join(extensionsDir, subdir.name);
        const manifestPath = path.join(extensionPath, 'manifest.json');

        try {
          const manifestContent = await fs.readFile(manifestPath, 'utf-8');
          const manifest = JSON.parse(manifestContent);
          const extensionId = manifest.id || subdir.name;

          // Skip if we've already seen this extension
          if (seenExtensionIds.has(extensionId)) {
            continue;
          }
          seenExtensionIds.add(extensionId);

          // Skip extensions that require a different release channel
          if (!isExtensionVisibleForChannel(manifest, currentChannel)) {
            continue;
          }

          // Check if extension is enabled
          if (!getExtensionEnabled(extensionId)) {
            continue;
          }

          // Check if extension has a Claude plugin
          const claudePlugin = manifest.contributions?.claudePlugin;
          if (!claudePlugin) {
            continue;
          }

          // Check if the plugin is enabled
          const storedPluginEnabled = getClaudePluginEnabled(extensionId);
          const pluginEnabled = storedPluginEnabled ?? claudePlugin.enabledByDefault ?? true;
          if (!pluginEnabled) {
            continue;
          }

          // Try to read the plugin.json to get the actual plugin name for namespacing
          let pluginNamespace = extensionId; // Default to extension ID
          const pluginJsonPath = path.join(extensionPath, claudePlugin.path, '.claude-plugin', 'plugin.json');
          try {
            const pluginJsonContent = await fs.readFile(pluginJsonPath, 'utf-8');
            const pluginJson = JSON.parse(pluginJsonContent);
            if (pluginJson.name) {
              pluginNamespace = pluginJson.name;
            }
          } catch {
            // plugin.json not found or invalid, use extension ID
          }

          // Add commands from the plugin
          if (claudePlugin.commands && Array.isArray(claudePlugin.commands)) {
            for (const cmd of claudePlugin.commands) {
              commands.push({
                extensionId,
                extensionName: manifest.name || extensionId,
                pluginName: claudePlugin.displayName || 'Claude Plugin',
                pluginNamespace, // The namespace used in slash commands (e.g., "datamodellm" for "/datamodellm:datamodel")
                commandName: cmd.name,
                description: cmd.description || '',
              });
            }
          }
        } catch {
          // Skip directories without valid manifest
        }
      }
    }

    return commands;
  } catch (error) {
    logger.main.error('[ExtensionHandlers] Failed to get Claude plugin commands:', error);
    return [];
  }
}

/**
 * Scan a single extension directory for Claude plugins.
 */
async function scanDirectoryForClaudePlugins(
  extensionsDir: string,
  plugins: Array<{ type: 'local'; path: string }>,
  seenExtensionIds: Set<string>,
  currentChannel: ReleaseChannel
): Promise<void> {
  let subdirs;
  try {
    subdirs = await fs.readdir(extensionsDir, { withFileTypes: true });
  } catch {
    // Directory doesn't exist or can't be read
    return;
  }

  for (const subdir of subdirs) {
    // Handle both directories and symlinks to directories
    let isDir = subdir.isDirectory();
    if (!isDir && subdir.isSymbolicLink()) {
      try {
        const targetPath = path.join(extensionsDir, subdir.name);
        const stat = await fs.stat(targetPath);
        isDir = stat.isDirectory();
      } catch {
        // Symlink target doesn't exist
        continue;
      }
    }
    if (!isDir) continue;

    const extensionPath = path.join(extensionsDir, subdir.name);
    const manifestPath = path.join(extensionPath, 'manifest.json');

    try {
      const manifestContent = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent);

      // Check if extension is enabled
      const extensionId = manifest.id || subdir.name;

      // Skip if we've already seen this extension (user extensions take priority)
      if (seenExtensionIds.has(extensionId)) {
        continue;
      }
      seenExtensionIds.add(extensionId);

      // Skip extensions that require a different release channel
      if (!isExtensionVisibleForChannel(manifest, currentChannel)) {
        logger.main.debug(`[ExtensionHandlers] Skipping extension ${extensionId} (requires ${manifest.requiredReleaseChannel} channel)`);
        continue;
      }

      const isEnabled = getExtensionEnabled(extensionId);
      if (!isEnabled) {
        logger.main.debug(`[ExtensionHandlers] Skipping disabled extension: ${extensionId}`);
        continue;
      }

      // Check if extension has a Claude plugin contribution
      const claudePlugin = manifest.contributions?.claudePlugin;
      if (!claudePlugin?.path) {
        continue;
      }

      // Check if the plugin is enabled
      // Priority: stored setting > manifest enabledByDefault > true
      const storedPluginEnabled = getClaudePluginEnabled(extensionId);
      const pluginEnabled = storedPluginEnabled ?? claudePlugin.enabledByDefault ?? true;
      if (!pluginEnabled) {
        logger.main.debug(`[ExtensionHandlers] Skipping disabled Claude plugin from: ${extensionId}`);
        continue;
      }

      // Resolve the absolute path to the plugin directory
      const pluginPath = path.resolve(extensionPath, claudePlugin.path);

      // Verify the plugin path exists
      try {
        await fs.access(pluginPath);
      } catch {
        logger.main.warn(`[ExtensionHandlers] Claude plugin path not found: ${pluginPath}`);
        continue;
      }

      // Validate plugin.json against the Claude Code SDK's expected schema.
      // The SDK silently drops plugins with invalid plugin.json, so we catch
      // common issues here and log warnings to help extension developers.
      const pluginJsonPath = path.join(pluginPath, '.claude-plugin', 'plugin.json');
      try {
        const pluginJsonContent = await fs.readFile(pluginJsonPath, 'utf-8');
        const pluginJson = JSON.parse(pluginJsonContent);
        const issues: string[] = [];

        if (!pluginJson.name || typeof pluginJson.name !== 'string') {
          issues.push('"name" must be a non-empty string');
        } else if (pluginJson.name.includes(' ')) {
          issues.push('"name" cannot contain spaces (use kebab-case)');
        }

        if (pluginJson.author !== undefined && typeof pluginJson.author === 'string') {
          issues.push('"author" must be an object { name: string }, not a string. The SDK will silently reject this plugin.');
        }

        if (issues.length > 0) {
          logger.main.warn(`[ExtensionHandlers] Claude plugin ${extensionId} has plugin.json issues that may cause the SDK to reject it: ${issues.join('; ')}`);
        }
      } catch {
        // plugin.json missing or unreadable -- SDK will handle this
      }

      plugins.push({
        type: 'local' as const,
        path: pluginPath,
      });
      // logger.main.info(`[ExtensionHandlers] Found Claude plugin: ${extensionId} at ${pluginPath}`);
    } catch {
      // Skip directories without valid manifest
    }
  }
}

/**
 * Structure of the Claude Code CLI installed plugins file (~/.claude/plugins/installed_plugins.json)
 */
interface ClaudeCliInstalledPlugins {
  version: number;
  plugins: Record<string, Array<{
    scope: 'user' | 'project';
    projectPath?: string;  // Only present for project-scoped plugins
    installPath: string;
    version: string;
    installedAt: string;
    lastUpdated: string;
  }>>;
}

/**
 * Get Claude CLI plugins installed via the /plugin command.
 * Reads from ~/.claude/plugins/installed_plugins.json
 *
 * @param workspacePath - If provided, includes project-scoped plugins for this workspace
 */
async function getClaudeCliPluginPaths(workspacePath?: string): Promise<Array<{ type: 'local'; path: string }>> {
  const plugins: Array<{ type: 'local'; path: string }> = [];

  try {
    const os = await import('os');
    const installedPluginsPath = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');

    let content: string;
    try {
      content = await fs.readFile(installedPluginsPath, 'utf-8');
    } catch {
      // File doesn't exist - no CLI plugins installed
      return [];
    }

    let installedPlugins: ClaudeCliInstalledPlugins;
    try {
      installedPlugins = JSON.parse(content);
    } catch (parseError) {
      logger.main.error(`[ExtensionHandlers] Failed to parse CLI plugins JSON at ${installedPluginsPath}:`, parseError);
      return [];
    }

    // Normalize workspace path for comparison if provided
    const normalizedWorkspacePath = workspacePath ? path.resolve(workspacePath) : undefined;

    for (const [pluginKey, installations] of Object.entries(installedPlugins.plugins)) {
      for (const installation of installations) {
        // Include user-scoped plugins always
        if (installation.scope === 'user') {
          try {
            await fs.access(installation.installPath);
            plugins.push({
              type: 'local' as const,
              path: installation.installPath,
            });
            logger.main.debug(`[ExtensionHandlers] Found CLI plugin (user): ${pluginKey} at ${installation.installPath}`);
          } catch {
            logger.main.warn(`[ExtensionHandlers] CLI plugin path not found: ${installation.installPath}`);
          }
        }
        // Include project-scoped plugins only if workspace matches
        else if (installation.scope === 'project' && normalizedWorkspacePath && installation.projectPath) {
          const normalizedProjectPath = path.resolve(installation.projectPath);
          if (normalizedWorkspacePath === normalizedProjectPath || normalizedWorkspacePath.startsWith(normalizedProjectPath + path.sep)) {
            try {
              await fs.access(installation.installPath);
              plugins.push({
                type: 'local' as const,
                path: installation.installPath,
              });
              logger.main.debug(`[ExtensionHandlers] Found CLI plugin (project): ${pluginKey} at ${installation.installPath}`);
            } catch {
              logger.main.warn(`[ExtensionHandlers] CLI plugin path not found: ${installation.installPath}`);
            }
          }
        }
      }
    }
  } catch (error) {
    logger.main.error('[ExtensionHandlers] Failed to read CLI plugins:', error);
  }

  return plugins;
}

/**
 * Get Claude Agent SDK plugin paths from enabled extensions and CLI-installed plugins.
 * This is a main-process-native implementation that directly reads extension manifests
 * without requiring the renderer-process ExtensionLoader.
 *
 * Scans:
 * 1. User extensions directory
 * 2. Built-in extensions directory
 * 3. Claude CLI plugins (~/.claude/plugins/)
 *
 * User extensions take priority over built-in extensions with the same ID.
 *
 * @param workspacePath - If provided, includes project-scoped CLI plugins for this workspace
 * @returns Paths in the format expected by the Claude Agent SDK: { type: 'local', path: string }
 */
export async function getNativeClaudePluginPaths(workspacePath?: string): Promise<Array<{ type: 'local'; path: string }>> {
  try {
    const plugins: Array<{ type: 'local'; path: string }> = [];
    const seenExtensionIds = new Set<string>();
    const currentChannel = getReleaseChannel();

    // Scan all extension directories (user first, then built-in)
    const extensionDirs = await getAllExtensionDirectories();
    for (const extensionsDir of extensionDirs) {
      await scanDirectoryForClaudePlugins(extensionsDir, plugins, seenExtensionIds, currentChannel);
    }

    // Also scan CLI-installed plugins
    const cliPlugins = await getClaudeCliPluginPaths(workspacePath);
    plugins.push(...cliPlugins);

    // Deduplicate by resolved path (in case same plugin is both an extension and CLI-installed)
    const seenPaths = new Set<string>();
    const deduplicatedPlugins: Array<{ type: 'local'; path: string }> = [];
    for (const plugin of plugins) {
      const resolvedPath = path.resolve(plugin.path);
      if (!seenPaths.has(resolvedPath)) {
        seenPaths.add(resolvedPath);
        deduplicatedPlugins.push(plugin);
      } else {
        logger.main.debug(`[ExtensionHandlers] Skipping duplicate plugin: ${plugin.path}`);
      }
    }

    return deduplicatedPlugins;
  } catch (error) {
    logger.main.error('[ExtensionHandlers] Failed to get Claude plugin paths:', error);
    return [];
  }
}

export async function getClaudePluginPaths(workspacePath?: string): Promise<Array<{ type: 'local'; path: string }>> {
  return getNativeClaudePluginPaths(workspacePath);
}

/**
 * Register IPC handlers for extension operations.
 */
export function registerExtensionHandlers(): void {
  // Get the user extensions directory path (for installing new extensions)
  safeHandle('extensions:get-directory', async () => {
    try {
      return await getUserExtensionsDirectory();
    } catch (error) {
      logger.main.error('[ExtensionHandlers] Failed to get extensions directory:', error);
      throw error;
    }
  });

  // Get all extension directories (user + built-in)
  // Used by the renderer's ExtensionLoader to discover all extensions
  safeHandle('extensions:get-all-directories', async () => {
    try {
      return await getAllExtensionDirectories();
    } catch (error) {
      logger.main.error('[ExtensionHandlers] Failed to get all extensions directories:', error);
      throw error;
    }
  });

  // List subdirectories in a directory
  // Note: This also follows symlinks to directories
  safeHandle('extensions:list-directories', async (_event, dirPath: string) => {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const directories: string[] = [];

      for (const entry of entries) {
        // Check if it's a directory or a symlink to a directory
        if (entry.isDirectory()) {
          directories.push(entry.name);
        } else if (entry.isSymbolicLink()) {
          // For symlinks, check if the target is a directory
          try {
            const targetPath = path.join(dirPath, entry.name);
            const stat = await fs.stat(targetPath); // stat follows symlinks
            if (stat.isDirectory()) {
              directories.push(entry.name);
            }
          } catch {
            // Symlink target doesn't exist, skip
          }
        }
      }

      logger.main.debug('[ExtensionHandlers] Found directories:', directories);
      return directories;
    } catch (error) {
      logger.main.debug('[ExtensionHandlers] Failed to list directories:', error);
      return [];
    }
  });

  // Read a file as text
  safeHandle('extensions:read-file', async (_event, filePath: string) => {
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return content;
    } catch (error) {
      logger.main.error(`[ExtensionHandlers] Failed to read file ${filePath}:`, error);
      throw error;
    }
  });

  // Write content to a file
  safeHandle('extensions:write-file', async (_event, filePath: string, content: string) => {
    try {
      SessionFileWatcher.markEditorSave(filePath);
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, content, 'utf-8');
    } catch (error) {
      logger.main.error(`[ExtensionHandlers] Failed to write file ${filePath}:`, error);
      throw error;
    }
  });

  // Write binary content to a file (base64 encoded)
  safeHandle('extensions:write-binary', async (_event, filePath: string, base64Content: string) => {
    try {
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      const buffer = Buffer.from(base64Content, 'base64');
      await fs.writeFile(filePath, buffer);
    } catch (error) {
      logger.main.error(`[ExtensionHandlers] Failed to write binary file ${filePath}:`, error);
      throw error;
    }
  });

  // Check if a file exists
  safeHandle('extensions:file-exists', async (_event, filePath: string) => {
    try {
      await fs.access(filePath);
      return true;
    } catch (error) {
      // Log the error details to help debug intermittent file access issues
      logger.main.debug(`[ExtensionHandlers] File not found: ${filePath}`, error);
      return false;
    }
  });

  // Check if an extension should be visible based on its required release channel
  safeHandle('extensions:is-visible-for-channel', (_event, requiredChannel: string | undefined) => {
    const currentChannel = getReleaseChannel();
    return isExtensionVisibleForChannel({ requiredReleaseChannel: requiredChannel as ReleaseChannel | undefined }, currentChannel);
  });

  // Find files matching a glob pattern
  safeHandle(
    'extensions:find-files',
    async (_event, dirPath: string, pattern: string) => {
      const matches: string[] = [];
      const rootPath = path.resolve(dirPath);
      // buildExtensionFindFilesPlan extracts the literal directory prefix from the glob
      // pattern to narrow the scan root, but normalizedPattern retains those prefix segments.
      // This works because relativePath is computed from rootPath (not scanRoot), so the
      // full pattern still matches correctly against the full relative path.
      const { normalizedPattern, scanRoot } = buildExtensionFindFilesPlan(rootPath, pattern);

      if (scanRoot !== rootPath && !scanRoot.startsWith(rootPath + path.sep)) {
        logger.main.warn('[ExtensionHandlers] Refusing to scan outside workspace root:', {
          dirPath: rootPath,
          pattern,
          scanRoot,
        });
        return matches;
      }

      try {
        const stat = await fs.stat(scanRoot);
        if (!stat.isDirectory()) {
          return matches;
        }
      } catch {
        return matches;
      }

      async function scanDirectory(dir: string): Promise<void> {
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relativePath = path.relative(rootPath, fullPath).split(path.sep).join('/');

            if (entry.isDirectory()) {
              // Skip hidden directories and node_modules
              if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
                await scanDirectory(fullPath);
              }
            } else {
              // Check if file matches the pattern
              if (minimatch(relativePath, normalizedPattern) || minimatch(entry.name, normalizedPattern)) {
                matches.push(fullPath);
              }
            }
          }
        } catch (error) {
          // Ignore permission errors
        }
      }

      try {
        await scanDirectory(scanRoot);
        return matches;
      } catch (error) {
        logger.main.error('[ExtensionHandlers] Failed to find files:', error);
        return [];
      }
    }
  );

  // Resolve a path relative to an extension
  safeHandle(
    'extensions:resolve-path',
    (_event, extensionPath: string, relativePath: string) => {
      return path.resolve(extensionPath, relativePath);
    }
  );

  // Get list of installed extensions (for settings UI)
  // Scans both user extensions and built-in extensions directories.
  // User extensions take priority over built-in extensions with the same ID.
  // Extensions with requiredReleaseChannel are filtered based on user's release channel.
  // Bundled MARKETPLACE-ONLY extensions (those shipped as .nimext packages in
  // resources/bundled-extensions/) are NOT reported as installed when found
  // only in the built-in dir -- they appear there in dev because the source
  // folder is a sibling under packages/extensions/, but the contract is that
  // the user must explicitly install them through the marketplace into the
  // user extensions dir before they count as installed.
  safeHandle('extensions:list-installed', async () => {
    try {
      const extensions: Array<{
        id: string;
        path: string;
        manifest: unknown;
        isBuiltin: boolean;
      }> = [];
      const seenExtensionIds = new Set<string>();
      const currentChannel = getReleaseChannel();
      const bundledOnlyIds = new Set(await getBundledOnlyExtensionIds());

      // Clear previously registered file types
      clearRegisteredExtensions();

      // Scan all extension directories (user first, then built-in)
      const extensionDirs = await getAllExtensionDirectories();

      for (let i = 0; i < extensionDirs.length; i++) {
        const extensionsDir = extensionDirs[i];
        const isBuiltinDir = i > 0; // First directory is user extensions

        let subdirs;
        try {
          subdirs = await fs.readdir(extensionsDir, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const subdir of subdirs) {
          // Handle both directories and symlinks to directories
          let isDir = subdir.isDirectory();
          if (!isDir && subdir.isSymbolicLink()) {
            try {
              const targetPath = path.join(extensionsDir, subdir.name);
              const stat = await fs.stat(targetPath);
              isDir = stat.isDirectory();
            } catch {
              continue;
            }
          }
          if (!isDir) continue;

          const extensionPath = path.join(extensionsDir, subdir.name);
          const manifestPath = path.join(extensionPath, 'manifest.json');

          try {
            const manifestContent = await fs.readFile(manifestPath, 'utf-8');
            const manifest = JSON.parse(manifestContent);
            const extensionId = manifest.id || subdir.name;

            // Skip if we've already seen this extension (user extensions take priority)
            if (seenExtensionIds.has(extensionId)) {
              continue;
            }

            // Skip bundled marketplace-only extensions encountered in the
            // BUILT-IN dir. They only count as installed once the user has
            // explicitly installed them through the marketplace (which copies
            // the .nimext into the user extensions dir; that copy is picked
            // up earlier in the loop because user dirs come first).
            if (isBuiltinDir && bundledOnlyIds.has(extensionId)) {
              logger.main.debug(`[ExtensionHandlers] Skipping bundled marketplace-only extension ${extensionId} from built-in dir (not user-installed)`);
              continue;
            }

            seenExtensionIds.add(extensionId);

            // Skip extensions that require a different release channel
            if (!isExtensionVisibleForChannel(manifest, currentChannel)) {
              logger.main.debug(`[ExtensionHandlers] Skipping extension ${extensionId} from list (requires ${manifest.requiredReleaseChannel} channel)`);
              continue;
            }

            // Register file patterns from customEditors
            if (manifest.contributions?.customEditors) {
              for (const editor of manifest.contributions.customEditors) {
                if (editor.filePatterns) {
                  for (const pattern of editor.filePatterns) {
                    // Extract extension from pattern like "*.pdf"
                    if (pattern.startsWith('*.')) {
                      const ext = pattern.substring(1); // Remove the *
                      registerFileExtension(ext);
                      logger.main.debug(`[ExtensionHandlers] Registered file type: ${ext} (from ${extensionId})`);
                    }
                  }
                }
              }
            }

            extensions.push({
              id: extensionId,
              path: extensionPath,
              manifest,
              isBuiltin: isBuiltinDir,
            });
          } catch {
            // Skip directories without valid manifest
          }
        }
      }

      return extensions;
    } catch (error) {
      logger.main.error('[ExtensionHandlers] Failed to list installed extensions:', error);
      return [];
    }
  });

  // Get Claude plugin commands from all enabled extensions
  // Used to populate slash command suggestions in the UI
  safeHandle('extensions:get-claude-plugin-commands', async () => {
    return await getExtensionPluginCommands();
  });

  // Get all extension settings
  safeHandle('extensions:get-all-settings', async () => {
    try {
      return getExtensionSettings();
    } catch (error) {
      logger.main.error('[ExtensionHandlers] Failed to get extension settings:', error);
      return {};
    }
  });

  // Get enabled state for a specific extension
  // defaultEnabled comes from the extension's manifest and is used for first-time discovery
  safeHandle('extensions:get-enabled', async (_event, extensionId: string, defaultEnabled?: boolean) => {
    try {
      return getExtensionEnabled(extensionId, defaultEnabled);
    } catch (error) {
      logger.main.error(`[ExtensionHandlers] Failed to get enabled state for ${extensionId}:`, error);
      return defaultEnabled !== false; // Respect manifest default on error
    }
  });

  // Set enabled state for a specific extension
  safeHandle('extensions:set-enabled', async (_event, extensionId: string, enabled: boolean) => {
    try {
      setExtensionEnabled(extensionId, enabled);
      logger.main.info(`[ExtensionHandlers] Extension ${extensionId} ${enabled ? 'enabled' : 'disabled'}`);
      return { success: true };
    } catch (error) {
      logger.main.error(`[ExtensionHandlers] Failed to set enabled state for ${extensionId}:`, error);
      return { success: false, error: String(error) };
    }
  });

  // Set Claude plugin enabled state for a specific extension
  safeHandle('extensions:set-claude-plugin-enabled', async (_event, extensionId: string, enabled: boolean) => {
    try {
      setClaudePluginEnabled(extensionId, enabled);
      logger.main.info(`[ExtensionHandlers] Claude plugin for ${extensionId} ${enabled ? 'enabled' : 'disabled'}`);
      return { success: true };
    } catch (error) {
      logger.main.error(`[ExtensionHandlers] Failed to set Claude plugin state for ${extensionId}:`, error);
      return { success: false, error: String(error) };
    }
  });

  safeHandle('extensions:set-agent-workflows-enabled', async (_event, extensionId: string, enabled: boolean) => {
    try {
      setAgentWorkflowsEnabled(extensionId, enabled);
      logger.main.info(`[ExtensionHandlers] Agent workflows for ${extensionId} ${enabled ? 'enabled' : 'disabled'}`);
      return { success: true };
    } catch (error) {
      logger.main.error(`[ExtensionHandlers] Failed to set agent workflow state for ${extensionId}:`, error);
      return { success: false, error: String(error) };
    }
  });

  // Get configuration for a specific extension (scope-aware)
  // scope: 'user' for global config, 'workspace' for project-specific config
  safeHandle('extensions:get-config', async (_event, extensionId: string, scope?: 'user' | 'workspace', workspacePath?: string) => {
    try {
      if (scope === 'workspace' && workspacePath) {
        return getWorkspaceExtensionConfiguration(workspacePath, extensionId);
      }
      return getExtensionConfiguration(extensionId);
    } catch (error) {
      logger.main.error(`[ExtensionHandlers] Failed to get config for ${extensionId}:`, error);
      return {};
    }
  });

  // Set a single configuration value for an extension (scope-aware)
  safeHandle('extensions:set-config', async (_event, extensionId: string, key: string, value: unknown, scope?: 'user' | 'workspace', workspacePath?: string) => {
    try {
      if (scope === 'workspace' && workspacePath) {
        setWorkspaceExtensionConfiguration(workspacePath, extensionId, key, value);
      } else {
        setExtensionConfiguration(extensionId, key, value);
      }
      logger.main.info(`[ExtensionHandlers] Set config ${key} for ${extensionId} (scope: ${scope ?? 'user'})`);
      return { success: true };
    } catch (error) {
      logger.main.error(`[ExtensionHandlers] Failed to set config for ${extensionId}:`, error);
      return { success: false, error: String(error) };
    }
  });

  // Set all configuration values for an extension (scope-aware)
  safeHandle('extensions:set-config-bulk', async (_event, extensionId: string, configuration: Record<string, unknown>, scope?: 'user' | 'workspace', workspacePath?: string) => {
    try {
      if (scope === 'workspace' && workspacePath) {
        setWorkspaceExtensionConfigurationBulk(workspacePath, extensionId, configuration);
      } else {
        setExtensionConfigurationBulk(extensionId, configuration);
      }
      logger.main.info(`[ExtensionHandlers] Set bulk config for ${extensionId} (scope: ${scope ?? 'user'})`);
      return { success: true };
    } catch (error) {
      logger.main.error(`[ExtensionHandlers] Failed to set bulk config for ${extensionId}:`, error);
      return { success: false, error: String(error) };
    }
  });

  // ============================================================================
  // Extension Development Kit (EDK) - Hot-loading handlers
  // ============================================================================

  // Install an extension from a specific path (for development)
  // This creates a symlink in the user extensions directory pointing to the dev extension
  safeHandle('extensions:dev-install', async (_event, extensionPath: string) => {
    try {
      const normalizedPath = path.resolve(extensionPath);
      const manifestPath = path.join(normalizedPath, 'manifest.json');

      // Verify manifest exists
      try {
        await fs.access(manifestPath);
      } catch {
        return { success: false, error: `No manifest.json found at ${normalizedPath}` };
      }

      // Read manifest to get extension ID
      const manifestContent = await fs.readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestContent);
      const extensionId = manifest.id;

      if (!extensionId) {
        return { success: false, error: 'manifest.json missing required "id" field' };
      }

      // Create symlink in user extensions directory
      const userExtDir = await getUserExtensionsDirectory();
      const symlinkPath = path.join(userExtDir, path.basename(normalizedPath));

      // Remove existing symlink if present
      try {
        const stat = await fs.lstat(symlinkPath);
        if (stat.isSymbolicLink() || stat.isDirectory()) {
          await fs.rm(symlinkPath, { recursive: true, force: true });
        }
      } catch {
        // Doesn't exist, that's fine
      }

      // Create symlink
      await fs.symlink(normalizedPath, symlinkPath, 'junction');
      logger.main.info(`[ExtensionHandlers] Created dev extension symlink: ${symlinkPath} -> ${normalizedPath}`);

      return { success: true, extensionId, symlinkPath };
    } catch (error) {
      logger.main.error('[ExtensionHandlers] Failed to install dev extension:', error);
      return { success: false, error: String(error) };
    }
  });

  // Uninstall a dev extension (remove symlink and notify renderers)
  safeHandle('extensions:dev-uninstall', async (_event, extensionId: string) => {
    try {
      const userExtDir = await getUserExtensionsDirectory();

      // Find the extension directory (could be a symlink)
      const entries = await fs.readdir(userExtDir, { withFileTypes: true });

      for (const entry of entries) {
        const entryPath = path.join(userExtDir, entry.name);

        // Check if this entry matches the extension ID
        const manifestPath = path.join(entryPath, 'manifest.json');
        try {
          const manifestContent = await fs.readFile(manifestPath, 'utf-8');
          const manifest = JSON.parse(manifestContent);

          if (manifest.id === extensionId) {
            // Found it - remove the symlink/directory
            await fs.rm(entryPath, { recursive: true, force: true });
            logger.main.info(`[ExtensionHandlers] Removed dev extension: ${extensionId} at ${entryPath}`);
            return { success: true };
          }
        } catch {
          // Not a valid extension directory, skip
        }
      }

      return { success: false, error: `Extension ${extensionId} not found in user extensions` };
    } catch (error) {
      logger.main.error('[ExtensionHandlers] Failed to uninstall dev extension:', error);
      return { success: false, error: String(error) };
    }
  });

  // Notify all renderer processes to reload an extension
  // The renderers will unload the old version and load the new one
  safeHandle('extensions:dev-reload', async (_event, extensionId: string, extensionPath: string) => {
    try {
      const { BrowserWindow } = await import('electron');
      const windows = BrowserWindow.getAllWindows();

      logger.main.info(`[ExtensionHandlers] Broadcasting extension reload: ${extensionId} from ${extensionPath}`);

      // Broadcast reload message to all renderer windows
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send('extension:dev-reload', { extensionId, extensionPath });
        }
      }

      return { success: true };
    } catch (error) {
      logger.main.error('[ExtensionHandlers] Failed to broadcast extension reload:', error);
      return { success: false, error: String(error) };
    }
  });

  // Notify all renderer processes to unload an extension
  safeHandle('extensions:dev-unload', async (_event, extensionId: string) => {
    try {
      const { BrowserWindow } = await import('electron');
      const windows = BrowserWindow.getAllWindows();

      logger.main.info(`[ExtensionHandlers] Broadcasting extension unload: ${extensionId}`);

      // Broadcast unload message to all renderer windows
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send('extension:dev-unload', { extensionId });
        }
      }

      return { success: true };
    } catch (error) {
      logger.main.error('[ExtensionHandlers] Failed to broadcast extension unload:', error);
      return { success: false, error: String(error) };
    }
  });

  // Execute a shell command on behalf of an extension (requires filesystem permission)
  safeHandle('extension:exec', async (_event, params: {
    extensionId: string;
    command: string;
    cwd: string;
    timeout?: number;
    env?: Record<string, string>;
    maxBuffer?: number;
  }) => {
    const { extensionId, command, cwd, timeout = 60000, env, maxBuffer = 10 * 1024 * 1024 } = params;

    // Find extension manifest by scanning extension directories
    let hasFilesystemPermission = false;
    const extensionDirs = await getAllExtensionDirectories();
    for (const extDir of extensionDirs) {
      let subdirs;
      try {
        subdirs = await fs.readdir(extDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const subdir of subdirs) {
        let isDir = subdir.isDirectory();
        if (!isDir && subdir.isSymbolicLink()) {
          try {
            const stat = await fs.stat(path.join(extDir, subdir.name));
            isDir = stat.isDirectory();
          } catch { continue; }
        }
        if (!isDir) continue;
        const manifestPath = path.join(extDir, subdir.name, 'manifest.json');
        try {
          const manifestJson = await fs.readFile(manifestPath, 'utf-8');
          const manifest = JSON.parse(manifestJson);
          if (manifest.id === extensionId) {
            hasFilesystemPermission = !!manifest.permissions?.filesystem;
            break;
          }
        } catch { continue; }
      }
      if (hasFilesystemPermission) break;
    }

    if (!hasFilesystemPermission) {
      return { success: false, stdout: '', stderr: `Extension ${extensionId} not found or lacks filesystem permission`, exitCode: -1 };
    }

    const { exec } = await import('child_process');
    const { promisify } = await import('util');
    const execAsync = promisify(exec);

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd,
        timeout,
        maxBuffer,
        env: env ? { ...process.env, ...env } : process.env,
      });
      return { success: true, stdout, stderr, exitCode: 0 };
    } catch (execError: unknown) {
      const err = execError as { stdout?: string; stderr?: string; code?: number; message?: string };
      return {
        success: false,
        stdout: err.stdout || '',
        stderr: err.stderr || err.message || '',
        exitCode: err.code || 1,
      };
    }
  });

  // ============================================================================
  // Extension Streaming Spawn Bridge (long-lived bidirectional child process)
  //
  // Unlike extension:exec (one-shot, buffered), this spawns a persistent process
  // and streams stdout/stderr/exit back to the SENDER renderer over IPC, and
  // accepts stdin writes. Needed for protocols that hold an open stdio channel
  // (e.g. `gemini --acp`). Gated on the manifest `process` permission.
  // ============================================================================

  spawnedProcesses ??= new Map<string, SpawnedProcessEntry>();

  // Spawn a long-lived child process on behalf of an extension (requires process permission)
  safeHandle('extension:spawn', async (event, params: {
    extensionId: string;
    command: string;
    args?: string[];
    options?: { cwd?: string; env?: Record<string, string> };
  }) => {
    const { extensionId, command, args = [], options } = params;

    // SECURITY: validate the (renderer-supplied, spoofable) extensionId against
    // installed manifests and require the `process` permission before spawning.
    // TODO: bind event.sender -> extensionId so the id cannot be spoofed by a
    //   different panel; depends on the extension-loader sender registry.
    const manifest = await findExtensionManifestById(extensionId);
    if (!manifest) {
      return { success: false, error: `Extension ${extensionId} not found` };
    }
    const permissions = manifest.permissions as { process?: boolean } | undefined;
    if (!permissions?.process) {
      return { success: false, error: `Extension ${extensionId} lacks process permission` };
    }

    const { spawn } = await import('child_process');

    // On Windows, npm-installed CLIs resolve to a .cmd/.bat shim. Node 20.12.2+ /
    // 22 refuse to spawn .cmd/.bat without a shell (CVE-2024-27980 mitigation), so
    // run the bare command name through a shell with its dir prepended to PATH.
    // Mirrors GeminiACPProtocol.ensureProcess.
    // Build a string env merged with the app's enhanced PATH so npm-global CLIs
    // (e.g. gemini) resolve even when the GUI process PATH is minimal. Extensions
    // cannot see the enhanced PATH themselves, so the bridge supplies it.
    const spawnEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (typeof v === 'string') spawnEnv[k] = v;
    }
    if (options?.env) {
      for (const [k, v] of Object.entries(options.env)) {
        if (typeof v === 'string') spawnEnv[k] = v;
      }
    }
    spawnEnv.PATH = getEnhancedPath() + path.delimiter + (spawnEnv.PATH ?? spawnEnv.Path ?? '');

    const isWin = process.platform === 'win32';
    const hasPathSeparator = command.includes('/') || command.includes('\\');
    const isWinScript = isWin && /\.(cmd|bat)$/i.test(command);
    let spawnCommand = command;
    // On Windows, .cmd/.bat (CVE-2024-27980) and bare command names both need a
    // shell so PATHEXT resolves e.g. `gemini` -> `gemini.cmd` against PATH.
    let useShell = isWinScript || (isWin && !hasPathSeparator);
    if (isWinScript) {
      const dir = path.dirname(command);
      spawnEnv.PATH = dir + path.delimiter + spawnEnv.PATH;
      spawnCommand = path.basename(command);
    }

    const handleId = `spawn-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

    let child;
    try {
      child = spawn(spawnCommand, args, {
        cwd: options?.cwd,
        env: spawnEnv,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: useShell,
        windowsHide: true,
      });
    } catch (spawnError: unknown) {
      const msg = spawnError instanceof Error ? spawnError.message : String(spawnError);
      return { success: false, error: `Failed to spawn: ${msg}` };
    }

    const sender = event.sender;
    spawnedProcesses!.set(handleId, { child, extensionId, senderId: sender.id });

    const sendToSender = (channel: string, payload: unknown) => {
      // The renderer may have navigated/closed; guard against a destroyed sender.
      if (!sender.isDestroyed()) {
        sender.send(channel, payload);
      }
    };

    child.stdout?.on('data', (data: Buffer) => {
      sendToSender('extension:spawn:stdout', { handleId, data: data.toString() });
    });
    child.stderr?.on('data', (data: Buffer) => {
      sendToSender('extension:spawn:stderr', { handleId, data: data.toString() });
    });
    child.on('error', (err: Error) => {
      sendToSender('extension:spawn:stderr', { handleId, data: `[spawn error] ${err.message}\n` });
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      sendToSender('extension:spawn:exit', { handleId, code, signal });
      spawnedProcesses!.delete(handleId);
    });

    logger.main.info(`[ExtensionHandlers] Spawned process for ${extensionId}: ${command} (handle=${handleId})`);
    return { success: true, handleId };
  });

  // Write to a spawned process's stdin
  safeHandle('extension:spawn:write', async (event, params: { handleId: string; data: string }) => {
    const { handleId, data } = params;
    const entry = spawnedProcesses?.get(handleId);
    if (!entry) {
      return { success: false, error: `No spawned process for handle ${handleId}` };
    }
    // Only the renderer that created the handle may write to it.
    if (entry.senderId !== event.sender.id) {
      return { success: false, error: `Handle ${handleId} not owned by sender` };
    }
    if (!entry.child.stdin || entry.child.stdin.destroyed) {
      return { success: false, error: `Process stdin not writable for handle ${handleId}` };
    }
    try {
      entry.child.stdin.write(data);
      return { success: true };
    } catch (writeError: unknown) {
      const msg = writeError instanceof Error ? writeError.message : String(writeError);
      return { success: false, error: `Write failed: ${msg}` };
    }
  });

  // Kill a spawned process and clean up its handle
  safeHandle('extension:spawn:kill', async (event, params: { handleId: string }) => {
    const { handleId } = params;
    const entry = spawnedProcesses?.get(handleId);
    if (!entry) {
      // Already gone (e.g. exited). Treat as success for idempotent cleanup.
      return { success: true };
    }
    if (entry.senderId !== event.sender.id) {
      return { success: false, error: `Handle ${handleId} not owned by sender` };
    }
    try {
      entry.child.kill();
    } catch (killError: unknown) {
      const msg = killError instanceof Error ? killError.message : String(killError);
      logger.main.warn(`[ExtensionHandlers] Failed to kill handle ${handleId}: ${msg}`);
    }
    spawnedProcesses!.delete(handleId);
    return { success: true };
  });

  // ============================================================================
  // Extension File Storage (sandboxed file system for extensions)
  // ============================================================================

  // Get the base path for an extension's data directory
  safeHandle('extension:file-storage:get-base-path', async (_event, params: {
    extensionId: string;
    workspacePath: string;
    scope: 'workspace' | 'global';
  }) => {
    const basePath = await getExtensionDataPath(params.extensionId, params.workspacePath, params.scope);
    await fs.mkdir(basePath, { recursive: true });
    return basePath;
  });

  // Write a file (string or base64-encoded binary)
  safeHandle('extension:file-storage:write', async (_event, params: {
    extensionId: string;
    workspacePath: string;
    relativePath: string;
    data: string;
    encoding: 'utf-8' | 'base64';
  }) => {
    const basePath = await getExtensionDataPath(params.extensionId, params.workspacePath, 'workspace');
    const fullPath = resolveSandboxedPath(basePath, params.relativePath);

    // Check quota (default 500MB per extension)
    const usage = await getDirectorySize(path.join(getExtensionDataRoot(), params.extensionId));
    const limitBytes = 500 * 1024 * 1024;
    if (usage > limitBytes) {
      throw new Error(`Extension ${params.extensionId} has exceeded its storage quota (${Math.round(usage / 1024 / 1024)}MB / ${Math.round(limitBytes / 1024 / 1024)}MB)`);
    }

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    if (params.encoding === 'base64') {
      await fs.writeFile(fullPath, Buffer.from(params.data, 'base64'));
    } else {
      await fs.writeFile(fullPath, params.data, 'utf-8');
    }
  });

  // Read a file as text
  safeHandle('extension:file-storage:read-text', async (_event, params: {
    extensionId: string;
    workspacePath: string;
    relativePath: string;
  }) => {
    const basePath = await getExtensionDataPath(params.extensionId, params.workspacePath, 'workspace');
    const fullPath = resolveSandboxedPath(basePath, params.relativePath);
    return await fs.readFile(fullPath, 'utf-8');
  });

  // Read a file as base64
  safeHandle('extension:file-storage:read', async (_event, params: {
    extensionId: string;
    workspacePath: string;
    relativePath: string;
  }) => {
    const basePath = await getExtensionDataPath(params.extensionId, params.workspacePath, 'workspace');
    const fullPath = resolveSandboxedPath(basePath, params.relativePath);
    const buffer = await fs.readFile(fullPath);
    return buffer.toString('base64');
  });

  // Check if a file exists
  safeHandle('extension:file-storage:exists', async (_event, params: {
    extensionId: string;
    workspacePath: string;
    relativePath: string;
  }) => {
    const basePath = await getExtensionDataPath(params.extensionId, params.workspacePath, 'workspace');
    const fullPath = resolveSandboxedPath(basePath, params.relativePath);
    try {
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  });

  // Delete a file or directory
  safeHandle('extension:file-storage:delete', async (_event, params: {
    extensionId: string;
    workspacePath: string;
    relativePath: string;
  }) => {
    const basePath = await getExtensionDataPath(params.extensionId, params.workspacePath, 'workspace');
    const fullPath = resolveSandboxedPath(basePath, params.relativePath);
    await fs.rm(fullPath, { recursive: true, force: true });
  });

  // List files in a directory
  safeHandle('extension:file-storage:list', async (_event, params: {
    extensionId: string;
    workspacePath: string;
    relativePath?: string;
  }) => {
    const basePath = await getExtensionDataPath(params.extensionId, params.workspacePath, 'workspace');
    const fullPath = params.relativePath ? resolveSandboxedPath(basePath, params.relativePath) : basePath;
    await fs.mkdir(fullPath, { recursive: true });
    const entries = await fs.readdir(fullPath);
    return entries;
  });

  // Get storage usage
  safeHandle('extension:file-storage:usage', async (_event, params: {
    extensionId: string;
  }) => {
    const extRoot = path.join(getExtensionDataRoot(), params.extensionId);
    const usedBytes = await getDirectorySize(extRoot);
    const limitBytes = 500 * 1024 * 1024; // 500MB default
    return { usedBytes, limitBytes };
  });

  logger.main.info('[ExtensionHandlers] Extension handlers registered');
}

// ============================================================================
// Extension File Storage helpers
// ============================================================================

/** Get root directory for all extension data */
function getExtensionDataRoot(): string {
  return path.join(app.getPath('userData'), 'extension-data');
}

/** Compute the data directory path for an extension */
async function getExtensionDataPath(
  extensionId: string,
  workspacePath: string,
  scope: 'workspace' | 'global'
): Promise<string> {
  const root = getExtensionDataRoot();

  if (scope === 'global') {
    return path.join(root, extensionId, 'global');
  }

  // Hash the workspace path for a stable, filesystem-safe directory name
  const crypto = await import('crypto');
  const hash = crypto.createHash('sha256').update(workspacePath).digest('hex').substring(0, 16);
  return path.join(root, extensionId, 'workspaces', hash);
}

/**
 * Resolve a relative path within a sandbox directory.
 * Throws if the resolved path escapes the sandbox.
 */
function resolveSandboxedPath(basePath: string, relativePath: string): string {
  // Normalize and resolve
  const resolved = path.resolve(basePath, relativePath);
  const normalizedBase = path.resolve(basePath);

  // Ensure the resolved path is within the base directory
  if (!resolved.startsWith(normalizedBase + path.sep) && resolved !== normalizedBase) {
    throw new Error(`Path traversal blocked: ${relativePath} resolves outside sandbox`);
  }

  return resolved;
}

/** Calculate total size of a directory recursively */
async function getDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        totalSize += await getDirectorySize(entryPath);
      } else {
        const stat = await fs.stat(entryPath);
        totalSize += stat.size;
      }
    }
  } catch {
    // Directory doesn't exist yet
  }
  return totalSize;
}
