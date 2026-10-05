# Git Folder

> Keep Git data outside the workspace.

Git Folder adds a small button to the VS Code status bar for creating separate Git directories outside the workspace.

## How it works

Choose a root directory once. Each project gets its own Git directory inside it using Git's `--separate-git-dir` option.

The workspace itself stays where it is.

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
