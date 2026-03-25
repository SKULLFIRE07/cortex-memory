# Contributing to Cortex

Thanks for your interest in contributing to Cortex! This guide will get you up and running in under 5 minutes.

## Prerequisites

- **Node.js 20+** (check with `node -v`)
- **npm** (comes with Node)
- **VSCode** 1.85+

## Getting Started

```bash
git clone https://github.com/cortex-dev/cortex.git
cd cortex
npm install
npm run build
```

## Development Workflow

Start the watch mode for automatic rebuilds on save:

```bash
npm run watch
```

To test the extension in VSCode:

1. Open the project in VSCode
2. Press **F5** to launch the Extension Development Host
3. The extension activates automatically in any workspace with a `CLAUDE.md` file or `.cortex` directory

## Project Structure

```
src/
  cli/          # CLI entry point (`cortex` command)
  engine/
    extractor/  # LLM-based memory extraction from sessions
    injector/   # Writes working memory into CLAUDE.md
    memory/     # Memory store (working, episodic, semantic layers)
    watcher/    # Session file watcher and JSONL parser
    hooks/      # Git hooks manager
    compressor.ts
    orchestrator.ts  # Main orchestrator tying everything together
  extension/
    providers/  # VSCode tree view and webview providers
    index.ts    # Extension activation entry point
  mcp/          # MCP server for external tool integration
  types/        # Shared TypeScript type definitions
```

## Code Style

- **TypeScript** with strict mode
- **Semicolons** at end of statements
- **Single quotes** for strings
- **2-space indentation**
- **Trailing commas** in multi-line arrays/objects

Run the linter before submitting:

```bash
npm run lint
```

## Running Tests

```bash
npm test
```

## Pull Request Process

1. Fork the repo and create a branch from `master`
2. Make your changes with clear, focused commits
3. Run `npm run lint` and `npm test` before pushing
4. Open a PR with a clear title and description of what changed and why
5. Link any related issues

## Reporting Issues

- Search existing issues first to avoid duplicates
- Use the provided issue templates for [bug reports](.github/ISSUE_TEMPLATE/bug_report.md) and [feature requests](.github/ISSUE_TEMPLATE/feature_request.md)
- Include reproduction steps for bugs
- Include your Node, VSCode, and OS versions

## Good First Issues

Looking for a place to start? Here are some areas where contributions are welcome:

- **Tests** -- Many modules in `src/engine/` need unit test coverage
- **Documentation** -- Improve inline JSDoc comments across the codebase
- **LLM providers** -- Add support for new LLM backends in the extraction engine
- **Memory viewers** -- Improve the sidebar webview UI for memory health
- **CLI commands** -- Extend the `cortex` CLI with new subcommands

Look for issues labeled [`good first issue`](https://github.com/cortex-dev/cortex/labels/good%20first%20issue) on GitHub.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
