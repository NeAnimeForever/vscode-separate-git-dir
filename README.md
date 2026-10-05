# VS Code Separate Git Dir

> Keep Git repositories outside the workspace.

A small VS Code extension for using Git's `--separate-git-dir` without typing the command manually.

## What it does

Choose one Git root and keep project repositories there while the working folders stay wherever you keep your projects.

The extension can also:

- create a separate Git repository for the current workspace;
- move an existing repository to the configured Git root;
- find and repair a broken `.git` link;
- open the external repository folder;
- disconnect a workspace without deleting its repository;
- switch between a Git file link and a Windows junction.

The default storage mode uses Git's `--separate-git-dir`. The junction mode is optional and Windows-only; it makes `.git` look like a directory for tools that expect one.

## Requirements

- Windows
- Git for Windows in `PATH`
- VS Code 1.90 or newer

## License

MIT.

Made by NeAnimeForever.

Yes, it is a small button.

Yes, I could write `git init --separate-git-dir` manually every time.

No, I am not going to.
