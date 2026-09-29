# Devin Orchestrator

CLI tool for delegating tasks to Devin agents via tmux sessions. Designed for Claude Code orchestration with bidirectional communication.

**Stack**: TypeScript, Bun, tmux, Devin CLI

**Structure**: Shell wrapper -> CLI entry point -> Job management -> tmux sessions

For detailed architecture, see [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md).

## Development

```bash
# Run directly
bun run src/cli.ts --help

# Or via shell wrapper
./bin/devin-agent --help

# Health check
bun run src/cli.ts health
```

## Key Files

| File | Purpose |
|------|---------|
| `src/cli.ts` | CLI commands and argument parsing |
| `src/jobs.ts` | Job lifecycle and persistence |
| `src/tmux.ts` | tmux session management |
| `src/config.ts` | Configuration constants |
| `src/files.ts` | File loading for context injection |
| `src/atif-parser.ts` | Parse Devin ATIF exports for metadata |
| `plugins/` | Claude Code plugin (marketplace structure) |

## Plugin Structure

This repo doubles as a Claude Code plugin marketplace:

```
.claude-plugin/marketplace.json     # marketplace registry
plugins/devin-orchestrator/         # the plugin
  .claude-plugin/plugin.json        # plugin metadata
  skills/devin-orchestrator/        # the orchestration skill
    SKILL.md                        # skill instructions
  scripts/install.sh                # dependency installer
```

## Dependencies

- **Runtime**: Bun, tmux, devin CLI
- **NPM**: glob (file matching)

## Notes

- Jobs stored in `~/.devin-agent/jobs/`
- Uses `script` command for output logging
- Completion detected via marker string in output
- Bun is the TypeScript runtime - never use npm/yarn/pnpm for running

## Claude Orchestration Pattern (Persisted)

- Use `devin-agent start "<task>"` without `--wait` for background orchestration.
- Track job IDs immediately.
- Use `devin-agent status <id>` to check running/completed state.
- Use `devin-agent capture <id> [n]` for incremental tails while running.
- Use `devin-agent output <id>` for final transcript after completion.
