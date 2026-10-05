const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const CONFIG_SECTION = 'vscodeSeparateGitDir';
const CONFIG_ROOT = 'gitRoot';
const BUTTON_ID = 'vscodeSeparateGitDir.status';


function execGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
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

function getWorkspace() {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== 'file') return null;
  return folder.uri.fsPath;
}

function getGitRoot() {
  const value = vscode.workspace.getConfiguration(CONFIG_SECTION).get(CONFIG_ROOT, '');
  return typeof value === 'string' ? value.trim() : '';
}

function getProjectGitPath(workspacePath, gitRoot) {
  return path.join(gitRoot, path.basename(path.normalize(workspacePath)));
}

function makePathLink(command, label) {
  return `[${label}](command:${command})`;
}

function updateStatusBar(item) {
  const workspacePath = getWorkspace();
  const gitRoot = getGitRoot();

  item.show();
  item.text = '$(repo) Git';

  if (!workspacePath) {
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    item.tooltip = new vscode.MarkdownString([
      `**${'VS Code Separate Git Dir'}**`,
      '',
      'First, open a local project folder in VS Code.',
    ].join('\n'));
    item.command = 'vscodeSeparateGitDir.create';
    return;
  }

  if (!gitRoot) {
    item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    item.color = new vscode.ThemeColor('statusBarItem.warningForeground');
    item.tooltip = new vscode.MarkdownString([
      `**${'VS Code Separate Git Dir'}**`,
      '',
      'The Git directory has not been selected yet.',
      '',
      'Click `Git` and the extension will guide you through the setup.',
    ].join('\n'));
    item.command = 'vscodeSeparateGitDir.create';
    return;
  }

  item.backgroundColor = undefined;
  item.color = undefined;
  const targetPath = getProjectGitPath(workspacePath, gitRoot);
  const tooltip = new vscode.MarkdownString([
    `**${'VS Code Separate Git Dir'}**`,
    '',
    'Repository for this project:',
    '',
    `\`${targetPath}\``,
    '',
    `${makePathLink('vscodeSeparateGitDir.selectRoot', 'Change path')}  ·  ${makePathLink('vscodeSeparateGitDir.create', 'Create / check')}`,
  ].join('\n'));
  tooltip.isTrusted = true;
  tooltip.supportHtml = false;
  item.tooltip = tooltip;
  item.command = 'vscodeSeparateGitDir.create';
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

async function selectRoot() {
  const workspacePath = getWorkspace();
  if (!workspacePath) {
    vscode.window.showWarningMessage('First, open a project folder in VS Code.');
    return;
  }

  const previousRoot = getGitRoot();
  const newRoot = await chooseGitRoot();
  if (!newRoot) return;

  updateStatusBar(statusBarItem);

  const action = await vscode.window.showInformationMessage(
    previousRoot ? `Git directory changed to ${newRoot}.` : `Git directory selected: ${newRoot}.`,
    'Create repository now',
    'Not now',
  );

  if (action === 'Create repository now') await createGitDirectory();
}

async function createGitDirectory() {
  const workspacePath = getWorkspace();

  if (!workspacePath) {
    const action = await vscode.window.showWarningMessage(
      'First, open a local project folder in VS Code.',
      'Open folder',
    );
    if (action === 'Open folder') await vscode.commands.executeCommand('vscode.openFolder');
    return;
  }

  if (process.platform !== 'win32') {
    vscode.window.showErrorMessage('VS Code Separate Git Dir is designed for Windows.');
    return;
  }

  let gitRoot = getGitRoot();
  if (!gitRoot) {
    const action = await vscode.window.showWarningMessage(
      'First, choose where to store Git repositories. You can change this at any time.',
      'Choose folder',
      'Not now',
    );

    if (action !== 'Choose folder') return;
    gitRoot = await chooseGitRoot();
    if (!gitRoot) return;
    updateStatusBar(statusBarItem);
  }

  const folderName = path.basename(path.normalize(workspacePath));
  const gitPath = getProjectGitPath(workspacePath, gitRoot);
  const dotGitPath = path.join(workspacePath, '.git');

  if (path.resolve(gitPath) === path.resolve(workspacePath)) {
    vscode.window.showErrorMessage('You cannot use the workspace itself as the separate Git directory. Choose another folder.');
    return;
  }

  try {
    await execGit(['--version'], workspacePath);
  } catch {
    const action = await vscode.window.showErrorMessage(
      'Git was not found. Install Git for Windows and restart VS Code.',
      'Open Git website',
    );
    if (action === 'Open Git website') await vscode.env.openExternal(vscode.Uri.parse('https://git-scm.com/download/win'));
    return;
  }

  if (await exists(dotGitPath)) {
    const action = await vscode.window.showInformationMessage(
      `This folder already contains a \`.git\` directory or file.\n\n${dotGitPath}`,
      'Open folder',
      'Close',
    );
    if (action === 'Open folder') await vscode.env.openExternal(vscode.Uri.file(workspacePath));
    return;
  }

  await fs.promises.mkdir(gitRoot, { recursive: true });

  if (await exists(gitPath) && !(await isEmptyDirectory(gitPath))) {
    const action = await vscode.window.showErrorMessage(
      `The Git directory for this project already exists and is not empty:\n\n${gitPath}`,
      'Choose another path',
      'Close',
    );
    if (action === 'Choose another path') await selectRoot();
    return;
  }

  await fs.promises.mkdir(gitPath, { recursive: true });

  try {
    await execGit(['init', `--separate-git-dir=${gitPath}`, workspacePath], workspacePath);
    updateStatusBar(statusBarItem);
    const action = await vscode.window.showInformationMessage(
      `Done. Git for ${folderName} is now stored here:\n\n${gitPath}`,
      'Open Git folder',
    );
    if (action === 'Open Git folder') await vscode.env.openExternal(vscode.Uri.file(gitPath));
  } catch (error) {
    try {
      if (await isEmptyDirectory(gitPath)) await fs.promises.rmdir(gitPath);
    } catch {}

    const details = String(error.stderr || error.message || '').trim();
    vscode.window.showErrorMessage(`Could not create the Git repository.${details ? ` ${details}` : ''}`);
  }
}

let statusBarItem;

function activate(context) {
  statusBarItem = vscode.window.createStatusBarItem(BUTTON_ID, vscode.StatusBarAlignment.Left, 1000);
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(vscode.commands.registerCommand('vscodeSeparateGitDir.create', createGitDirectory));
  context.subscriptions.push(vscode.commands.registerCommand('vscodeSeparateGitDir.selectRoot', selectRoot));

  context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => updateStatusBar(statusBarItem)));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration(`${CONFIG_SECTION}.${CONFIG_ROOT}`)) updateStatusBar(statusBarItem);
  }));

  updateStatusBar(statusBarItem);
}

module.exports = { activate };
