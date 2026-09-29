# Devin Orchestrator - Claude Code Plugin

A Claude Code plugin that lets Claude orchestrate Devin agents. Claude handles strategy and synthesis while Devin agents handle deep coding work in parallel tmux sessions.

## What It Does

When installed, Claude gains the ability to:

- **Spawn Devin agents** for research, implementation, review, and testing
- **Monitor agent progress** via structured JSON output
- **Redirect agents mid-task** when they need course correction
- **Synthesize findings** from multiple parallel agents into clear results
- **Follow a structured pipeline**: Ideation -> Research -> Synthesis -> PRD -> Implementation -> Review -> Testing

You describe what you want. Claude breaks it into tasks, delegates to Devin agents, monitors progress, and reports back.

## Installation

### Via Marketplace

```
/plugin marketplace add leofmarciano/devin-orchestrator
/plugin install devin-orchestrator
```

### Manual

Clone and install:

```bash
git clone https://github.com/leofmarciano/devin-orchestrator.git ~/.devin-orchestrator
cd ~/.devin-orchestrator && bun install
export PATH="$HOME/.devin-orchestrator/bin:$PATH"  # add to ~/.bashrc or ~/.zshrc
```

### Dependencies

The `devin-agent` CLI and its dependencies must be installed:

```bash
# Install tmux
brew install tmux                  # macOS
# sudo apt-get install -y tmux    # Ubuntu/Debian

# Install Bun
curl -fsSL https://bun.sh/install | bash

# Install Devin CLI
curl -fsSL https://cli.devin.ai/install.sh | sh

# Authenticate with Devin (required)
devin auth login

# Install devin-orchestrator CLI
git clone https://github.com/leofmarciano/devin-orchestrator.git ~/.devin-orchestrator
cd ~/.devin-orchestrator && bun install
export PATH="$HOME/.devin-orchestrator/bin:$PATH"  # add to ~/.bashrc or ~/.zshrc
```

Or use the bundled installer:

```bash
bash plugins/devin-orchestrator/scripts/install.sh
```

## Usage

The skill activates automatically when you ask Claude to do coding tasks:

```
/devin-orchestrator
```

Or just describe what you want:
- "investigate the auth module for security issues"
- "implement the feature from the PRD"
- "review the recent changes"
- "run tests and fix failures"

Claude will spawn appropriate Devin agents and manage the process.

## The Pipeline

```
YOUR REQUEST
     |
     v
[IDEATION] --> [RESEARCH] --> [SYNTHESIS] --> [PRD] --> [IMPLEMENTATION] --> [REVIEW] --> [TESTING]
  Claude        Devin          Claude         Claude      Devin             Devin         Devin
  + You         read-only                     + You       workspace-write   read-only     workspace-write
```

**Claude** handles strategic stages: ideation, synthesis, PRD creation.
**Devin agents** handle execution stages: research, implementation, review, testing.

## Agent Timing

Devin agents take time - this is normal and expected:

| Task Type | Typical Duration |
|-----------|------------------|
| Simple research | 10-20 minutes |
| Single feature | 20-40 minutes |
| Complex implementation | 30-60+ minutes |

## CLI Reference

The plugin uses the `devin-agent` CLI under the hood:

```bash
devin-agent start "task" -r high --map -s read-only   # spawn
devin-agent jobs --json                                # monitor
devin-agent capture <id>                               # check output
devin-agent send <id> "new instructions"               # redirect
devin-agent kill <id>                                  # stop (last resort)
```

See the [main README](../../README.md) for full CLI documentation.

## License

MIT
