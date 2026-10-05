const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CONFIG_SECTION = 'vscodeSeparateGitDir';
const CONFIG_ROOT = 'gitRoot';
const CONFIG_MODE = 'storageMode';
const BUTTON_ID = 'vscodeSeparateGitDir.status';
const COMMANDS = {
  manage: 'vscodeSeparateGitDir.manage',
  create: 'vscodeSeparateGitDir.create',
  selectRoot: 'vscodeSeparateGitDir.selectRoot',
  move: 'vscodeSeparateGitDir.move',
  repair: 'vscodeSeparateGitDir.repair',
  open: 'vscodeSeparateGitDir.open',
  disconnect: 'vscodeSeparateGitDir.disconnect',
  mode: 'vscodeSeparateGitDir.mode',
};

function execGit(args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function execCommand(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function exists(targetPath) {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function isEmptyDirectory(targetPath) {
  try {
    return (await fs.promises.readdir(targetPath)).length === 0;
  } catch {
    return false;
  }
}

async function getStat(targetPath) {
  try {
    return await fs.promises.lstat(targetPath);
  } catch {
    return null;
  }
}

function getWorkspace() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder && folder.uri.scheme === 'file' ? folder.uri.fsPath : null;
}

function getGitRoot() {
  const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get(CONFIG_ROOT, '');
  return typeof value === 'string' ? value.trim() : '';
}

function getStorageMode() {
  const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get(CONFIG_MODE, 'separate-git-dir');
  return value === 'junction' ? 'junction' : 'separate-git-dir';
}

function getProjectGitPath(workspacePath, gitRoot) {
  return path.join(gitRoot, path.basename(path.normalize(workspacePath)));
}

function isSamePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function makePathLink(command, label) {
  return `[${label}](command:${command})`;
}

function commandLink(command, label) {
  return makePathLink(command, label);
}

function modeLabel(mode) {
  return mode === 'junction' ? 'Windows junction' : 'Separate Git directory';
}

async function getRepoInfo(workspacePath) {
  const dotGitPath = path.join(workspacePath, '.git');
  const stat = await getStat(dotGitPath);

  if (!stat) return { kind: 'none', dotGitPath, exists: false };

  if (stat.isDirectory()) {
    try {
      const realPath = await fs.promises.realpath(dotGitPath);
      const originalPath = path.resolve(dotGitPath);
      const isJunction = process.platform === 'win32' && !isSamePath(originalPath, realPath);
      return { kind: isJunction ? 'junction' : 'normal', dotGitPath, path: realPath, exists: true };
    } catch {
      return { kind: 'normal', dotGitPath, path: dotGitPath, exists: true };
    }
  }

  if (stat.isFile()) {
    try {
      const content = await fs.promises.readFile(dotGitPath, 'utf8');
      const match = content.match(/^gitdir:\s*(.+?)\s*$/mi);
      if (!match) return { kind: 'invalid', dotGitPath, exists: true };
      const gitPath = path.normalize(path.isAbsolute(match[1]) ? match[1] : path.resolve(workspacePath, match[1]));
      return { kind: 'separate', dotGitPath, path: gitPath, exists: await exists(gitPath) };
    } catch {
      return { kind: 'invalid', dotGitPath, exists: true };
    }
  }

  return { kind: 'invalid', dotGitPath, exists: true };
}

async function isGitRepository(workspacePath, gitPath) {
  try {
    const bare = await execGit(['--git-dir', gitPath, 'rev-parse', '--is-bare-repository'], workspacePath);
    if (bare.stdout.trim() !== 'false') return false;
    const top = await execGit(['--git-dir', gitPath, '--work-tree', workspacePath, 'rev-parse', '--show-toplevel'], workspacePath);
    return isSamePath(top.stdout.trim(), workspacePath);
  } catch {
    return false;
  }
}

async function ensureGitAvailable(workspacePath) {
  try {
    await execGit(['--version'], workspacePath);
    return true;
  } catch {
    const action = await vscode.window.showErrorMessage('Git was not found. Install Git for Windows and restart VS Code.', 'Open Git website');
    if (action === 'Open Git website') await vscode.env.openExternal(vscode.Uri.parse('https://git-scm.com/download/win'));
    return false;
  }
}

async function chooseGitRoot() {
  const selected = await vscode.window.showOpenDialog({
    title: 'Choose the folder where separate Git repositories should be stored',
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Select folder',
  });
  if (!selected?.length) return null;
  const gitRoot = selected[0].fsPath;
  await vscode.workspace.getConfiguration(CONFIG_SECTION).update(CONFIG_ROOT, gitRoot, vscode.ConfigurationTarget.Global);
  return gitRoot;
}

async function ensureRoot() {
  let root = getGitRoot();
  if (root) return root;
  const action = await vscode.window.showWarningMessage('Choose a folder where this extension should store Git repositories.', 'Choose folder', 'Not now');
  if (action !== 'Choose folder') return null;
  root = await chooseGitRoot();
  if (root) updateStatusBar(statusBarItem);
  return root;
}

async function createJunction(linkPath, targetPath) {
  if (process.platform !== 'win32') throw new Error('Windows junctions are only available on Windows.');
  if (await exists(linkPath)) throw new Error(`Cannot create the junction because ${linkPath} already exists.`);
  await execCommand('cmd.exe', ['/d', '/c', 'mklink', '/J', linkPath, targetPath]);
}

async function convertSeparateToJunction(repoInfo) {
  if (repoInfo.kind !== 'separate') return;
  await fs.promises.unlink(repoInfo.dotGitPath);
  try {
    await createJunction(repoInfo.dotGitPath, repoInfo.path);
  } catch (error) {
    await fs.promises.writeFile(repoInfo.dotGitPath, `gitdir: ${repoInfo.path}\n`, 'utf8');
    throw error;
  }
}

async function convertJunctionToSeparate(repoInfo) {
  if (repoInfo.kind !== 'junction') return;
  await fs.promises.rmdir(repoInfo.dotGitPath);
  try {
    await fs.promises.writeFile(repoInfo.dotGitPath, `gitdir: ${repoInfo.path}\n`, 'utf8');
  } catch (error) {
    try { await createJunction(repoInfo.dotGitPath, repoInfo.path); } catch {}
    throw error;
  }
}

async function convertStorageMode(repoInfo, mode) {
  if (mode === 'junction' && repoInfo.kind === 'separate') {
    await convertSeparateToJunction(repoInfo);
  } else if (mode === 'separate-git-dir' && repoInfo.kind === 'junction') {
    await convertJunctionToSeparate(repoInfo);
  }
}

async function validateExternalRepository(workspacePath, gitPath) {
  if (isSamePath(workspacePath, gitPath) || isInside(workspacePath, gitPath)) return false;
  return isGitRepository(workspacePath, gitPath);
}

async function openPath(targetPath) {
  await vscode.env.openExternal(vscode.Uri.file(targetPath));
}

function updateStatusBar(item) {
  const workspacePath = getWorkspace();
  const gitRoot = getGitRoot();

  item.show();
  item.name = 'Git Folder';
  item.text = '$(git-branch) Git Folder';
  item.command = COMMANDS.manage;

  if (!workspacePath) {
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    item.tooltip = new vscode.MarkdownString(['**Git Folder**', '', 'Open a local workspace to use Git Folder.'].join('\n'));
    return;
  }

  if (!gitRoot) {
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    const tooltip = new vscode.MarkdownString(['**Git Folder**', '', 'No Git root has been selected yet.', '', commandLink(COMMANDS.selectRoot, 'Choose Git root')].join('\n'));
    tooltip.isTrusted = true;
    item.tooltip = tooltip;
    return;
  }

  item.backgroundColor = undefined;
  item.color = undefined;
  const targetPath = getProjectGitPath(workspacePath, gitRoot);
  const tooltip = new vscode.MarkdownString(['**Git Folder**', '', `Git root: \`${gitRoot}\``, '', `Project repository: \`${targetPath}\``, '', commandLink(COMMANDS.selectRoot, 'Change Git root')].join('\n'));
  tooltip.isTrusted = true;
  item.tooltip = tooltip;

  getRepoInfo(workspacePath).then(info => {
    if (info.kind === 'separate' || info.kind === 'junction') {
      const currentPath = info.path;
      const currentTargetExists = info.exists;
      const state = currentTargetExists ? `${modeLabel(info.kind === 'junction' ? 'junction' : 'separate-git-dir')}` : 'Repository not found';
      const dynamicTooltip = new vscode.MarkdownString([
        '**Git Folder**',
        '',
        `Git root: \`${gitRoot}\``,
        '',
        `Repository: \`${currentPath}\``,
        `Storage: **${state}**`,
        '',
        currentTargetExists ? commandLink(COMMANDS.open, 'Open repository') : commandLink(COMMANDS.repair, 'Find / repair'),
        '  ·  ' + commandLink(COMMANDS.move, 'Move repository'),
        '',
        commandLink(COMMANDS.selectRoot, 'Change Git root') + '  ·  ' + commandLink(COMMANDS.disconnect, 'Disconnect'),
      ].join('\n'));
      dynamicTooltip.isTrusted = true;
      item.tooltip = dynamicTooltip;
    } else if (info.kind === 'normal') {
      const dynamicTooltip = new vscode.MarkdownString(['**Git Folder**', '', 'This project has a regular `.git` directory.', '', `The extension can move it to: \`${targetPath}\``, '', commandLink(COMMANDS.move, 'Move repository') + '  ·  ' + commandLink(COMMANDS.selectRoot, 'Change Git root')].join('\n'));
      dynamicTooltip.isTrusted = true;
      item.tooltip = dynamicTooltip;
    } else if (info.kind === 'invalid') {
      const dynamicTooltip = new vscode.MarkdownString(['**Git Folder**', '', 'The project has a `.git` file, but it could not be read.', '', commandLink(COMMANDS.repair, 'Find / repair') + '  ·  ' + commandLink(COMMANDS.disconnect, 'Remove broken link')].join('\n'));
      dynamicTooltip.isTrusted = true;
      item.tooltip = dynamicTooltip;
    } else {
      const dynamicTooltip = new vscode.MarkdownString(['**Git Folder**', '', `Git repository: \`${targetPath}\``, '', 'This project is not connected yet.', '', commandLink(COMMANDS.create, 'Create repository') + '  ·  ' + commandLink(COMMANDS.selectRoot, 'Change Git root')].join('\n'));
      dynamicTooltip.isTrusted = true;
      item.tooltip = dynamicTooltip;
    }
  }).catch(() => {});
}

async function selectRoot() {
  const workspacePath = getWorkspace();
  if (!workspacePath) {
    vscode.window.showWarningMessage('Open a local project folder in VS Code first.');
    return;
  }

  const previousRoot = getGitRoot();
  const newRoot = await chooseGitRoot();
  if (!newRoot) return;
  updateStatusBar(statusBarItem);

  const info = await getRepoInfo(workspacePath);
  if (info.kind === 'normal' || info.kind === 'separate' || info.kind === 'junction') {
    const action = await vscode.window.showInformationMessage('Git root changed. The current repository was not moved.', 'Move current repository', 'Not now');
    if (action === 'Move current repository') await moveRepository();
  } else if (!previousRoot) {
    await vscode.window.showInformationMessage(`Git root selected: ${newRoot}.`);
  }
}

async function createGitDirectory() {
  const workspacePath = getWorkspace();
  if (!workspacePath) {
    vscode.window.showWarningMessage('Open a local project folder in VS Code first.');
    return;
  }
  if (process.platform !== 'win32') {
    vscode.window.showErrorMessage('VS Code Separate Git Dir is designed for Windows.');
    return;
  }
  if (!(await ensureGitAvailable(workspacePath))) return;

  const gitRoot = await ensureRoot();
  if (!gitRoot) return;
  const folderName = path.basename(path.normalize(workspacePath));
  const targetPath = getProjectGitPath(workspacePath, gitRoot);
  const dotGitPath = path.join(workspacePath, '.git');
  const info = await getRepoInfo(workspacePath);

  if (info.kind === 'invalid') {
    vscode.window.showErrorMessage('This project has an unreadable .git file. Use Find / repair or remove it first.');
    return;
  }

  if (info.kind === 'separate' || info.kind === 'junction') {
    if (isSamePath(info.path, targetPath)) {
      vscode.window.showInformationMessage(`Git for ${folderName} is already stored at ${targetPath}.`);
      return;
    }
    const action = await vscode.window.showInformationMessage(`This project already uses Git at ${info.path}.`, 'Move to Git root', 'Not now');
    if (action === 'Move to Git root') await moveRepository();
    return;
  }

  if (info.kind === 'normal') {
    const action = await vscode.window.showInformationMessage(`This project already has a Git repository in .git.`, 'Move to Git root', 'Not now');
    if (action === 'Move to Git root') await moveRepository();
    return;
  }

  if (isSamePath(targetPath, workspacePath) || isInside(workspacePath, targetPath)) {
    vscode.window.showErrorMessage('The Git repository must be outside the workspace folder. Choose another Git root.');
    return;
  }

  if (await exists(targetPath) && !(await isEmptyDirectory(targetPath))) {
    const action = await vscode.window.showErrorMessage(`The target Git directory already exists and is not empty:\n\n${targetPath}`, 'Change Git root', 'Close');
    if (action === 'Change Git root') await selectRoot();
    return;
  }

  await fs.promises.mkdir(gitRoot, { recursive: true });
  await fs.promises.mkdir(targetPath, { recursive: true });

  try {
    await execGit(['init', `--separate-git-dir=${targetPath}`, workspacePath], workspacePath);
    let resultPath = targetPath;
    if (getStorageMode() === 'junction') {
      const newInfo = await getRepoInfo(workspacePath);
      await convertSeparateToJunction(newInfo);
      resultPath = targetPath;
    }
    updateStatusBar(statusBarItem);
    const action = await vscode.window.showInformationMessage(`Git for ${folderName} is now stored here:\n\n${resultPath}`, 'Open Git folder');
    if (action === 'Open Git folder') await openPath(resultPath);
  } catch (error) {
    try {
      if (await exists(targetPath) && (await isEmptyDirectory(targetPath))) await fs.promises.rmdir(targetPath);
    } catch {}
    const details = String(error.stderr || error.message || '').trim();
    vscode.window.showErrorMessage(`Could not create the Git repository.${details ? ` ${details}` : ''}`);
  }
}

async function moveRepository() {
  const workspacePath = getWorkspace();
  if (!workspacePath) {
    vscode.window.showWarningMessage('Open a local project folder in VS Code first.');
    return;
  }
  if (process.platform !== 'win32') {
    vscode.window.showErrorMessage('VS Code Separate Git Dir is designed for Windows.');
    return;
  }
  if (!(await ensureGitAvailable(workspacePath))) return;
  const gitRoot = await ensureRoot();
  if (!gitRoot) return;

  const info = await getRepoInfo(workspacePath);
  if (info.kind === 'none') {
    await createGitDirectory();
    return;
  }
  if (info.kind === 'invalid') {
    vscode.window.showErrorMessage('This project has an unreadable .git file. Use Find / repair first.');
    return;
  }
  if ((info.kind === 'separate' || info.kind === 'junction') && !info.exists) {
    const action = await vscode.window.showErrorMessage(`The linked Git repository could not be found:\n\n${info.path}`, 'Find / repair', 'Cancel');
    if (action === 'Find / repair') await repairRepository();
    return;
  }

  const targetPath = getProjectGitPath(workspacePath, gitRoot);
  const targetExists = await exists(targetPath);
  if (targetExists && !(await isEmptyDirectory(targetPath)) && !isSamePath(targetPath, info.path || '')) {
    const action = await vscode.window.showErrorMessage(`The destination already exists and is not empty:\n\n${targetPath}`, 'Change Git root', 'Cancel');
    if (action === 'Change Git root') await selectRoot();
    return;
  }
  if (isSamePath(targetPath, info.path || '')) {
    vscode.window.showInformationMessage(`Git is already stored at ${targetPath}.`);
    return;
  }

  try {
    if (info.kind === 'junction') {
      await convertJunctionToSeparate(info);
    }
    await execGit(['init', `--separate-git-dir=${targetPath}`, workspacePath], workspacePath);
    if (getStorageMode() === 'junction') {
      const newInfo = await getRepoInfo(workspacePath);
      await convertSeparateToJunction(newInfo);
    }
    updateStatusBar(statusBarItem);
    const action = await vscode.window.showInformationMessage(`Git repository moved to:\n\n${targetPath}`, 'Open Git folder');
    if (action === 'Open Git folder') await openPath(targetPath);
  } catch (error) {
    const details = String(error.stderr || error.message || '').trim();
    vscode.window.showErrorMessage(`Could not move the Git repository.${details ? ` ${details}` : ''}`);
  }
}

async function repairRepository() {
  const workspacePath = getWorkspace();
  if (!workspacePath) {
    vscode.window.showWarningMessage('Open a local project folder in VS Code first.');
    return;
  }
  if (process.platform !== 'win32') {
    vscode.window.showErrorMessage('VS Code Separate Git Dir is designed for Windows.');
    return;
  }
  if (!(await ensureGitAvailable(workspacePath))) return;

  const info = await getRepoInfo(workspacePath);
  if (info.kind === 'separate' && info.exists) {
    vscode.window.showInformationMessage(`The Git repository is already available at ${info.path}.`);
    return;
  }
  if (info.kind !== 'separate' && info.kind !== 'invalid') {
    vscode.window.showWarningMessage('There is no broken external Git link to repair in this project.');
    return;
  }

  const selected = await vscode.window.showOpenDialog({
    title: 'Find the Git repository for this project',
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Use repository',
  });
  if (!selected?.length) return;

  const gitPath = selected[0].fsPath;
  if (!(await validateExternalRepository(workspacePath, gitPath))) {
    vscode.window.showErrorMessage('The selected folder is not a valid non-bare Git repository outside the workspace.');
    return;
  }

  const confirm = await vscode.window.showWarningMessage(`Connect this project to:\n\n${gitPath}\n\nThe existing .git link will be replaced. The Git repository itself will not be changed.`, 'Connect repository', 'Cancel');
  if (confirm !== 'Connect repository') return;

  const dotGitPath = path.join(workspacePath, '.git');
  try {
    if (await exists(dotGitPath)) await fs.promises.unlink(dotGitPath);
    await fs.promises.writeFile(dotGitPath, `gitdir: ${gitPath}\n`, 'utf8');
    if (getStorageMode() === 'junction') {
      const newInfo = await getRepoInfo(workspacePath);
      await convertSeparateToJunction(newInfo);
    }
    updateStatusBar(statusBarItem);
    vscode.window.showInformationMessage(`Git repository restored: ${gitPath}`);
  } catch (error) {
    const details = String(error.message || '').trim();
    vscode.window.showErrorMessage(`Could not repair the Git link.${details ? ` ${details}` : ''}`);
  }
}

async function openRepository() {
  const workspacePath = getWorkspace();
  if (!workspacePath) return;
  const info = await getRepoInfo(workspacePath);
  if ((info.kind === 'separate' || info.kind === 'junction') && info.exists) {
    await openPath(info.path);
    return;
  }
  if (info.kind === 'normal') {
    await openPath(info.path);
    return;
  }
  const action = await vscode.window.showWarningMessage('The external Git repository could not be found.', 'Find / repair');
  if (action === 'Find / repair') await repairRepository();
}

async function disconnectRepository() {
  const workspacePath = getWorkspace();
  if (!workspacePath) return;
  const info = await getRepoInfo(workspacePath);

  if (info.kind === 'separate' || info.kind === 'junction') {
    const action = await vscode.window.showWarningMessage(`Disconnect Git from this workspace?\n\nThe Git repository at ${info.path} will not be deleted.`, 'Disconnect', 'Cancel');
    if (action !== 'Disconnect') return;
    try {
      if (info.kind === 'junction') await fs.promises.rmdir(info.dotGitPath);
      else await fs.promises.unlink(info.dotGitPath);
      updateStatusBar(statusBarItem);
      vscode.window.showInformationMessage(`Disconnected. The Git repository was kept at ${info.path}.`);
    } catch (error) {
      vscode.window.showErrorMessage(`Could not disconnect the Git repository. ${error.message || ''}`.trim());
    }
    return;
  }

  if (info.kind === 'invalid') {
    const action = await vscode.window.showWarningMessage('The .git file is broken. Remove it? The external repository will not be deleted.', 'Remove link', 'Cancel');
    if (action !== 'Remove link') return;
    try {
      await fs.promises.unlink(info.dotGitPath);
      updateStatusBar(statusBarItem);
      vscode.window.showInformationMessage('Removed the broken .git link.');
    } catch (error) {
      vscode.window.showErrorMessage(`Could not remove the broken .git link. ${error.message || ''}`.trim());
    }
    return;
  }

  if (info.kind === 'normal') {
    vscode.window.showWarningMessage('This project uses a normal .git directory. Git Folder will not delete it.');
    return;
  }

  vscode.window.showInformationMessage('This project is not connected to an external Git repository.');
}

async function changeStorageMode() {
  const workspacePath = getWorkspace();
  const current = getStorageMode();
  const selected = await vscode.window.showQuickPick([
    { label: '$(file-directory) Separate Git directory', description: 'Git keeps a .git file pointing to the external repository.', value: 'separate-git-dir' },
    { label: '$(link) Windows junction', description: 'The workspace contains a .git directory link to the external repository.', value: 'junction' },
  ], { placeHolder: `Current mode: ${modeLabel(current)}` });
  if (!selected || selected.value === current) return;

  await vscode.workspace.getConfiguration(CONFIG_SECTION).update(CONFIG_MODE, selected.value, vscode.ConfigurationTarget.Global);

  if (!workspacePath) {
    updateStatusBar(statusBarItem);
    return;
  }

  const info = await getRepoInfo(workspacePath);
  if (info.kind === 'none') {
    updateStatusBar(statusBarItem);
    vscode.window.showInformationMessage(`Storage mode changed to ${modeLabel(selected.value)}. It will be used for new repositories.`);
    return;
  }
  if (info.kind === 'invalid' || (info.kind === 'separate' && !info.exists)) {
    updateStatusBar(statusBarItem);
    vscode.window.showInformationMessage(`Storage mode changed to ${modeLabel(selected.value)}. Repair the current repository before converting it.`);
    return;
  }
  if (info.kind === 'normal') {
    updateStatusBar(statusBarItem);
    vscode.window.showInformationMessage(`Storage mode changed to ${modeLabel(selected.value)}. Move this repository to apply it.`);
    return;
  }

  try {
    await convertStorageMode(info, selected.value);
    updateStatusBar(statusBarItem);
    vscode.window.showInformationMessage(`Current repository converted to ${modeLabel(selected.value)}.`);
  } catch (error) {
    await vscode.workspace.getConfiguration(CONFIG_SECTION).update(CONFIG_MODE, current, vscode.ConfigurationTarget.Global);
    updateStatusBar(statusBarItem);
    vscode.window.showErrorMessage(`Could not change the repository storage mode. ${error.message || ''}`.trim());
  }
}

async function manage() {
  const workspacePath = getWorkspace();
  if (!workspacePath) {
    const action = await vscode.window.showWarningMessage('Open a local project folder to use Git Folder.', 'Open folder');
    if (action === 'Open folder') await vscode.commands.executeCommand('vscode.openFolder');
    return;
  }

  const info = await getRepoInfo(workspacePath);
  const items = [];
  const hasGitRoot = !!getGitRoot();
  if (!hasGitRoot) items.push({ label: '$(folder-opened) Choose Git root', command: COMMANDS.selectRoot });
  if (info.kind === 'none') items.push({ label: '$(new-file) Create repository', command: COMMANDS.create });
  if (info.kind === 'normal') items.push({ label: '$(move) Move repository to Git root', command: COMMANDS.move });
  if (info.kind === 'invalid' || (info.kind === 'separate' && !info.exists)) items.push({ label: '$(search) Find / repair repository', command: COMMANDS.repair });
  if (info.kind === 'separate' || info.kind === 'junction') {
    if (info.exists) items.push({ label: '$(folder-opened) Open repository', command: COMMANDS.open });
    items.push({ label: '$(move) Move repository', command: COMMANDS.move });
    items.push({ label: '$(debug-disconnect) Disconnect (keep repository)', command: COMMANDS.disconnect });
  }
  if (info.kind === 'invalid') items.push({ label: '$(trash) Remove broken .git link', command: COMMANDS.disconnect });
  if (hasGitRoot) items.push({ label: '$(settings-gear) Change Git root', command: COMMANDS.selectRoot });
  items.push({ label: '$(symbol-interface) Change storage mode', command: COMMANDS.mode });

  const selected = await vscode.window.showQuickPick(items, { placeHolder: `Git Folder · ${modeLabel(getStorageMode())}` });
  if (!selected) return;
  await vscode.commands.executeCommand(selected.command);
}

let statusBarItem;

function activate(context) {
  statusBarItem = vscode.window.createStatusBarItem(BUTTON_ID, vscode.StatusBarAlignment.Left, 1000);
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(vscode.commands.registerCommand(COMMANDS.manage, manage));
  context.subscriptions.push(vscode.commands.registerCommand(COMMANDS.create, createGitDirectory));
  context.subscriptions.push(vscode.commands.registerCommand(COMMANDS.selectRoot, selectRoot));
  context.subscriptions.push(vscode.commands.registerCommand(COMMANDS.move, moveRepository));
  context.subscriptions.push(vscode.commands.registerCommand(COMMANDS.repair, repairRepository));
  context.subscriptions.push(vscode.commands.registerCommand(COMMANDS.open, openRepository));
  context.subscriptions.push(vscode.commands.registerCommand(COMMANDS.disconnect, disconnectRepository));
  context.subscriptions.push(vscode.commands.registerCommand(COMMANDS.mode, changeStorageMode));

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => updateStatusBar(statusBarItem)));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_ROOT}`) || event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_MODE}`)) updateStatusBar(statusBarItem);
  }));

  updateStatusBar(statusBarItem);
}

module.exports = { activate };
