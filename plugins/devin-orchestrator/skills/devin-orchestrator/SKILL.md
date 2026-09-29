---
name: devin-orchestrator
description: DEFAULT PIPELINE for all tasks requiring execution. You (Claude) are the strategic orchestrator. Devin agents are your implementation army - hyper-focused coding specialists. Trigger on ANY task involving code, file modifications, codebase research, multi-step work, or implementation. This is NOT optional - Devin agents are the default for all execution work. Only skip if the user explicitly asks you to do something yourself.
triggers:
  - devin-orchestrator
  - spawn devin
  - use devin
  - delegate to devin
  - start agent
  - devin agent
  - init
  - setup devin
---

# Devin Orchestrator

## The Command Structure

```
USER - directs the mission
    |
    ├── CLAUDE #1 (Opus) --- General
    |       ├── DEVIN agent
    |       ├── DEVIN agent
    |       └── DEVIN agent ...
    |
    ├── CLAUDE #2 (Opus) --- General
    |       ├── DEVIN agent
    |       └── DEVIN agent ...
    |
    ├── CLAUDE #3 (Opus) --- General
    |       └── DEVIN agent ...
    |
    └── CLAUDE #4 (Opus) --- General
            └── DEVIN agent ...
```

**The user is in command.** They set the vision, make strategic decisions, approve plans. They can direct multiple Claude instances simultaneously.

**You (Claude) are their general.** You command YOUR Devin army on the user's behalf. You are in FULL CONTROL of your agents:
- You decide which agents to spawn
- You decide what tasks to give them
- You coordinate your agents working in parallel
- You course-correct or kill agents as needed
- You synthesize your army's work into results for the user

The user can run 4+ Claude instances in parallel. Each Claude has its own Devin army. This is how massive codebases get built in days instead of weeks.

You handle the strategic layer. You translate the user's intent into actionable commands for YOUR army.

**Devin agents are the army under your command.** Hyper-focused coding specialists. Extremely thorough and effective in their domain - they read codebases deeply, implement carefully, and verify their work. They get the job done right.

Devin reports to you. You report to the user.

## CRITICAL RULES

### Rule 1: Devin Agents Are the Default

For ANY task involving:
- Writing or modifying code
- Researching the codebase
- Investigating files or patterns
- Security audits
- Testing
- Multi-step execution
- Anything requiring file access

**Spawn Devin agents. Do not do it yourself. Do not use Claude subagents.**

### Rule 2: You Are the Orchestrator, Not the Implementer

Your job:
- Discuss strategy with the user
- Write PRDs and specs
- Spawn and direct Devin agents
- Synthesize agent findings
- Make decisions about approach
- Communicate progress

Not your job:
- Implementing code yourself
- Doing extensive file reads to "understand before delegating"
- Using Claude subagents (Task tool) unless the user explicitly asks

### Rule 3: Only Exceptions

Use Claude subagents ONLY when:
- The user explicitly requests it ("you do it", "don't use Devin", "use a Claude subagent")
- Quick single-file read for conversational context

Otherwise: Devin agents. Always.

## Prerequisites

Before devin-agent can run, three things must be installed:

1. **tmux** - Terminal multiplexer (agents run in tmux sessions)
2. **Bun** - JavaScript runtime (runs the CLI)
3. **Devin CLI** - The coding agent being orchestrated

The user must also be **authenticated with Devin** (`devin auth login`) so agents can make API calls.

### Quick Check

```bash
devin-agent health    # checks tmux + devin are available
```

### If Not Installed

If the user says "init", "setup", or devin-agent is not found, **run the install script**:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/install.sh"
```

**Always use the install script.** Do NOT manually check dependencies or try to install things yourself step-by-step. The script handles everything: detects the platform, checks each dependency, installs what's missing via official package managers, clones the repo, and adds `devin-agent` to PATH. No sudo required.

If `${CLAUDE_PLUGIN_ROOT}` is not available (manual skill install), the user can run:

```bash
bash ~/.devin-orchestrator/plugins/devin-orchestrator/scripts/install.sh
```

After installation, the user must authenticate with Devin if they haven't already:

```bash
devin auth login
```

**All dependencies use official sources only.** tmux from system package managers, Bun from bun.sh, Devin CLI from the official installer (cli.devin.ai). No third-party scripts or unknown URLs.

## The Factory Pipeline

```
USER'S REQUEST
     |
     v
1. IDEATION        (You + User)
     |
2. RESEARCH         (Devin, read-only)
     |
3. SYNTHESIS        (You)
     |
4. PRD              (You + User)
     |
5. IMPLEMENTATION   (Devin, workspace-write)
     |
6. REVIEW           (Devin, read-only)
     |
7. TESTING          (Devin, workspace-write)
```

**You** handle stages 1, 3, 4 - the strategic work.
**Devin agents** handle stages 2, 5, 6, 7 - the execution work.

### Pipeline Stage Detection

Detect where you are based on context:

| Signal | Stage | Action |
|--------|-------|--------|
| New feature request, vague problem | IDEATION | Discuss with user, clarify scope |
| "investigate", "research", "understand" | RESEARCH | Spawn read-only Devin agents |
| Agent findings ready, need synthesis | SYNTHESIS | You review, filter, combine |
| "let's plan", "create PRD", synthesis done | PRD | You write PRD to docs/prds/ |
| PRD exists, "implement", "build" | IMPLEMENTATION | Spawn workspace-write Devin agents |
| Implementation done, "review" | REVIEW | Spawn review Devin agents |
| "test", "verify", review passed | TESTING | Spawn test-writing Devin agents |

## Core Principles

1. **Gold Standard Quality** - No shortcuts. Security, proper patterns, thorough testing - all of it.
2. **Always Interactive** - Agents stay open for course correction. Never kill and respawn - send a message to redirect.
3. **Parallel Execution** - Multiple Claude instances can spawn multiple Devin agents simultaneously.
4. **Codebase Map Always** - Every agent gets `--map` for context.
5. **PRDs Drive Implementation** - Complex changes get PRDs in docs/prds/.
6. **Patience is Required** - Agents take time. This is normal and expected.
7. **Turn-Aware by Default** - Use `await-turn` to block until agents respond. No manual polling.

## Agent Timing Expectations (CRITICAL - READ THIS)

**Devin agents take time. This is NORMAL. Do NOT be impatient.**

| Task Type | Typical Duration |
|-----------|------------------|
| Simple research | 10-20 minutes |
| Implementation (single feature) | 20-40 minutes |
| Complex implementation | 30-60+ minutes |
| Full PRD implementation | 45-90+ minutes |

**Why agents take this long:**
- They read the codebase thoroughly (not skimming)
- They think deeply about implications
- They implement carefully with proper patterns
- They verify their work (typecheck, tests)
- They handle edge cases

**When you keep talking to an agent via `devin-agent send`**, it stays open and continues working. Sessions can extend to 60+ minutes easily - and that is FINE. A single agent that you course-correct is often better than killing and respawning.

**Do NOT:**
- Kill agents just because they have been running for 20 minutes
- Assume something is wrong if an agent runs for 30+ minutes
- Spawn new agents to replace ones that are "taking too long"
- Ask the user "should I check on the agent?" after 15 minutes

**DO:**
- Use `devin-agent await-turn <id>` in a background Bash task to get notified instantly when an agent finishes
- Check progress with `devin-agent capture <id>` if you need to peek before a turn completes
- Send clarifying messages if the agent seems genuinely stuck (no progress for 5+ minutes)
- Let agents finish their work - they are thorough for a reason
- Trust the process - quality takes time

**`await-turn` has NO wall-clock timeout.** It blocks until one of: the agent completes a turn, hits the context window, the job ends, or you SIGINT. A long-running `await-turn` does NOT mean the agent is dead - it means the agent is still working. Never re-spawn just because `await-turn` has been blocked for a while.

## Codebase Map: Giving Agents Instant Context

The `--map` flag is the most important flag you'll use. It injects `docs/CODEBASE_MAP.md` into the agent's prompt - a comprehensive architecture document that gives agents instant understanding of the entire codebase: file purposes, module boundaries, data flows, dependencies, conventions, and navigation guides.

**Without a map**, agents waste time exploring and guessing at structure.
**With a map**, agents know exactly where things are and how they connect. They start working immediately instead of orienteering.

The map is generated by [Cartographer](https://github.com/kingbootoshi/cartographer), a separate Claude Code plugin that scans your codebase with parallel subagents and produces the map:

```
/plugin marketplace add kingbootoshi/cartographer
/plugin install cartographer
/cartographer
```

This creates `docs/CODEBASE_MAP.md`. After that, every `devin-agent start ... --map` command gives agents full architectural context.

**Always generate a codebase map before using devin-orchestrator on a new project.** It's the difference between agents that fumble around and agents that execute with precision.

## CLI Defaults

The CLI ships with strong defaults so most commands need minimal flags:

| Setting | Default | Why |
|---------|---------|-----|
| Model | `swe-2` | Full capability model |
| Reasoning | `medium` | Efficient default; raise with `-r high` or `-r xhigh` for harder work |
| Sandbox | `workspace-write` | Agents can modify files by default |

You almost never need to override these. The main flags you'll use are `--map` (include codebase context) and `-s read-only` (for research tasks).

## Turn-Aware Orchestration

Devin agents have a built-in notify hook that fires the instant an agent finishes responding. This means you get notified within milliseconds of an agent going idle - no polling, no delays, no forgetting to check.

### How It Works

When `devin-agent start` spawns an agent, it injects a per-job `Stop` lifecycle hook via `--config <jobId>.devin-config.json`. When the Devin agent finishes a turn, Devin pipes a JSON payload to our hook script's stdin. The script writes a signal file at `~/.devin-agent/jobs/<jobId>.turn-complete`. The `await-turn` command blocks until that file appears.

Cloud jobs (`--cloud`) run on a remote VM where the hook and ATIF export never fire; for those jobs `await-turn` instead polls the pane for the "Devin is awaiting instructions" idle marker. Cloud jobs have no `usage` totals in `status --json` (context-window stats still work), and `kill` only detaches the local view — the cloud session keeps running (`devin --cloud -r <session>` reopens it).

Each job gets its own notify command with its own job ID baked in. 16 agents running in the same directory? No ambiguity - each one's hook writes to its own signal file.

### The Standard Orchestration Loop

This is how you should interact with agents. Use this pattern every time.

**Step 1: Spawn** (foreground, instant - get the job ID)

```bash
devin-agent start "Your task prompt here" -r high --map -s read-only
```

Parse the job ID from the output.

**Step 2: Await** (blocks until agent responds)

Use the Bash tool with `run_in_background: true`:

```bash
JOB_ID="abc12345"
devin-agent await-turn "$JOB_ID"
echo "DEVIN_AGENT_TURN_COMPLETE=$JOB_ID"
devin-agent status "$JOB_ID"
```

This gives you a `task_id` from Claude's background task system. When the agent finishes its turn, `TaskOutput` returns the agent's response.

**Step 3: React** - Read the output, decide what to do next:
- Send a follow-up: `devin-agent send $id "Now do X"`
- Close it: `devin-agent send $id "/quit"`
- Just read more: `devin-agent capture $id 200 --clean`

If you send a follow-up, repeat Step 2 to await the next turn.

### Spawning Multiple Agents in Parallel

When spawning N agents, make all Step 1 calls in parallel (single message, multiple Bash tool calls). Then make all Step 2 calls in parallel (single message, multiple Bash tool calls with `run_in_background: true`).

```
Message 1 (parallel foreground):
  - Bash: devin-agent start "Research task A" --map -s read-only
  - Bash: devin-agent start "Research task B" --map -s read-only
  - Bash: devin-agent start "Research task C" --map -s read-only

Message 2 (parallel background):
  - Bash (bg): devin-agent await-turn <jobA>; echo "DONE_A"; devin-agent status <jobA>
  - Bash (bg): devin-agent await-turn <jobB>; echo "DONE_B"; devin-agent status <jobB>
  - Bash (bg): devin-agent await-turn <jobC>; echo "DONE_C"; devin-agent status <jobC>
```

Each background task notifies you independently the instant its agent finishes. No 3-second poll gaps. No wasted time.

### Multi-Turn Conversation Pattern

For tasks requiring back-and-forth with an agent:

```bash
# Spawn
devin-agent start "Investigate the auth module" --map -s read-only
# Block until agent responds
devin-agent await-turn $id
# Read what it said
devin-agent status $id
# Send follow-up
devin-agent send $id "Now check the database layer"
# Block again
devin-agent await-turn $id
# Read response, close when done
devin-agent send $id "/quit"
```

### Checking on Agents Without Waiting

You do NOT have to use await-turn. At any time you can still:

```bash
devin-agent status <jobId>           # includes turn state, last message
devin-agent capture <jobId> 50       # peek at recent output
devin-agent send <jobId> "message"   # steer the agent
devin-agent jobs --json              # check all agents at once
```

### When "completed" Actually Fires

A Devin job status stays `running` after the agent has answered - it only transitions to `completed` when the session is closed. This happens when:
- The agent finishes and exits naturally
- You send `/quit` via `devin-agent send <id> "/quit"`
- The session times out from inactivity

So if you use `await-turn`, you get the agent's response immediately. Then you decide whether to send a follow-up or close the session.

### Signal File Interface (For Advanced Bash Scripting)

The signal file is a plain JSON file. You can check it directly from bash without spawning a subprocess:

```bash
signal="$HOME/.devin-agent/jobs/${id}.turn-complete"
# Cheapest possible check - no subprocess
while [ ! -f "$signal" ]; do sleep 1; done
# Read the agent's message
cat "$signal"
```

The `devin-bg -t` wrapper also supports turn notifications:

```bash
devin-bg -t -- devin-agent start "task"
# Prints DEVIN_AGENT_TURN_COMPLETE=<id> on each turn
```

## CLI Reference

### Spawning Agents

```bash
# Research (read-only - override sandbox)
devin-agent start "Investigate auth flow for vulnerabilities" --map -s read-only

# Implementation (defaults are perfect - high reasoning, workspace-write)
devin-agent start "Implement the auth refactor per PRD" --map

# With file context
devin-agent start "Review the modules under src/auth and src/api" --map
```

### Monitoring Agents

```bash
# Wait for agent to finish current turn (PREFERRED - blocks until done)
devin-agent await-turn <jobId>

# Status with turn info - shows turn state, count, last message
devin-agent status <jobId>

# Structured status - tokens, files modified, summary
devin-agent jobs --json

# Human readable table
devin-agent jobs

# Recent output
devin-agent capture <jobId>
devin-agent capture <jobId> 200    # more lines

# Full output
devin-agent output <jobId>

# Live stream
devin-agent watch <jobId>
```

### Communicating with Agents

```bash
# Send follow-up message
devin-agent send <jobId> "Focus on the database layer"
devin-agent send <jobId> "The dependency is installed. Run bun run typecheck"

# Direct tmux attach (for full interaction)
tmux attach -t devin-agent-<jobId>
# Ctrl+B, D to detach
```

**IMPORTANT**: Use `devin-agent send`, not raw `tmux send-keys`. The send command handles escaping and timing properly.

### Control

```bash
devin-agent kill <jobId>           # stop agent (last resort)
devin-agent clean                  # remove old jobs (>7 days)
devin-agent health                 # verify devin + tmux available
```

## Flags Reference

| Flag | Short | Values | Description |
|------|-------|--------|-------------|
| `--reasoning` | `-r` | low, medium, high, xhigh | Reasoning depth |
| `--sandbox` | `-s` | read-only, workspace-write, danger-full-access | File access level |
| `--cloud` | | flag | Run as a Devin Cloud session on its own VM |
| `--mode` | | normal, plan, ask | Devin agent-mode (injects `/plan` or `/ask` first) |
| `--map` | | flag | Include docs/CODEBASE_MAP.md |
| `--dir` | `-d` | path | Working directory |
| `--model` | `-m` | string | Model override |
| `--json` | | flag | JSON output (`status`, `await-turn`, `jobs`) |
| `--strip-ansi` | | flag | Clean output |
| `--dry-run` | | flag | Preview prompt without executing |

## Jobs JSON Output

```json
{
  "id": "8abfab85",
  "status": "completed",
  "elapsed_ms": 14897,
  "tokens": {
    "input": 36581,
    "output": 282,
    "context_window": 258400,
    "context_used_pct": 14.16
  },
  "files_modified": ["src/auth.ts", "src/types.ts"],
  "summary": "Implemented the authentication flow..."
}
```

## Pipeline Stages in Detail

### Stage 1: Ideation (You + User)

Talk through the problem with the user. Understand what they want. Think about how to break it down for the Devin army.

**Your role here**: Strategic thinking, asking clarifying questions, proposing approaches.

Even seemingly simple tasks go to Devin agents - remember, you are the orchestrator, not the implementer. The only exception is if the user explicitly asks you to do it yourself.

### Stage 2: Research (Devin Agents - read-only)

Spawn parallel investigation agents:

```bash
devin-agent start "Map the data flow from API to database for user creation" --map -s read-only
devin-agent start "Identify all places where user validation occurs" --map -s read-only
devin-agent start "Find security vulnerabilities in user input handling" --map -s read-only
```

Log each spawn immediately in agents.log.

### Stage 3: Synthesis (You)

Review agent findings. This is where you add value as the orchestrator:

**Filter bullshit from gold:**
- Agent suggests splitting a 9k token file - likely good
- Agent suggests adding rate limiting - good, we want quality
- Agent suggests types for code we didn't touch - skip, over-engineering
- Agent contradicts itself - investigate further
- Agent misunderstands the codebase - discount that finding

**Combine insights:**
- What's the actual state of the code?
- What are the real problems?
- What's the right approach?

Write synthesis to agents.log.

### Stage 4: PRD Creation (You + User)

For significant changes, create PRD in `docs/prds/`:

```markdown
# [Feature/Fix Name]

## Problem
[What's broken or missing]

## Solution
[High-level approach]

## Requirements
- [Specific requirement 1]
- [Specific requirement 2]

## Implementation Plan
### Phase 1: [Name]
- [ ] Task 1
- [ ] Task 2

### Phase 2: [Name]
- [ ] Task 3

## Files to Modify
- path/to/file.ts - [what changes]

## Testing
- [ ] Unit tests for X
- [ ] Integration test for Y

## Success Criteria
- [How we know it's done]
```

Review PRD with user before implementation.

### Stage 5: Implementation (Devin Agents - workspace-write)

Spawn implementation agents with PRD context:

```bash
devin-agent start "Implement Phase 1 of docs/prds/auth-refactor.md. Read the PRD file first." --map
```

For large PRDs, implement in phases with separate agents.

### Stage 6: Review (Devin Agents - read-only)

Spawn parallel review agents:

```bash
# Security review
devin-agent start "Security review the changes. Check:
- OWASP top 10 vulnerabilities
- Auth bypass possibilities
- Data exposure risks
- Input validation
- SQL/command injection
Report any security concerns." --map -s read-only

# Error handling review
devin-agent start "Review error handling in changed files. Check for:
- Swallowed errors
- Missing validation
- Inconsistent patterns
- Raw errors exposed to clients
Report any violations." --map -s read-only

# Data integrity review
devin-agent start "Review for data integrity. Check:
- Existing data unaffected
- Database queries properly scoped
- No accidental data deletion
- Migrations are additive/safe
Report any concerns." --map -s read-only
```

**After review agents complete:**
- Synthesize findings
- Fix any critical issues before commit
- Note non-critical issues for future

### Stage 7: Testing (Devin Agents - workspace-write)

```bash
# Write tests
devin-agent start "Write comprehensive tests for the auth module changes" --map

# Run verification
devin-agent start "Run typecheck and tests. Fix any failures." --map
```

## Scaling: Multiple Claude Instances

The real power of this system is parallelism at every level:

```
USER runs 4 Claude instances simultaneously
  |
  Claude #1: researching auth module     (3 Devin agents)
  Claude #2: implementing feature A      (2 Devin agents)
  Claude #3: reviewing recent changes    (4 Devin agents)
  Claude #4: writing tests               (2 Devin agents)
```

When running multiple Claude Code sessions on the same codebase:
1. Each Claude instance spawns and manages its own agents independently
2. All instances share the same `agents.log` for coordination
3. Use job IDs to track which agent belongs to which Claude instance
4. Coordinate via agents.log entries to avoid duplicate work
5. Each Claude should claim a stage or module to prevent conflicts

This is how you get exponential execution: N Claude instances x M Devin agents each = N*M parallel workers on your codebase.

## agents.log Format

Maintain in project root. Shared across all Claude instances.

```markdown
# Agents Log

## Session: 2026-01-21T10:30:00Z
Goal: Refactor authentication system
PRD: docs/prds/auth-refactor.md

### Spawned: abc123 - 10:31
Type: research
Prompt: Investigate current auth flow, identify security gaps
Reasoning: high
Sandbox: read-only

### Spawned: def456 - 10:31
Type: research
Prompt: Analyze session management patterns
Reasoning: high
Sandbox: read-only

### Complete: abc123 - 10:45
Findings:
- JWT tokens stored in localStorage (XSS risk)
- No refresh token rotation
- Missing rate limiting on login endpoint
Files: src/auth/jwt.ts, src/auth/session.ts

### Complete: def456 - 10:47
Findings:
- Sessions never expire
- No concurrent session limits
Files: src/auth/session.ts, src/middleware/auth.ts

### Synthesis - 10:50
Combined: Auth system has 4 critical issues:
1. XSS-vulnerable token storage
2. No token rotation
3. No rate limiting
4. Infinite sessions
Approach: Create PRD with phased fix
Next: Write PRD to docs/prds/auth-security-hardening.md
```

## Multi-Agent Patterns

### Parallel Investigation

```bash
# Spawn 3 research agents simultaneously (parallel Bash calls)
devin-agent start "Audit auth flow" --map -s read-only          # -> jobA
devin-agent start "Review API security" --map -s read-only      # -> jobB
devin-agent start "Check data validation" --map -s read-only    # -> jobC

# Await all 3 in parallel (background Bash calls)
devin-agent await-turn $jobA; devin-agent status $jobA    # bg task 1
devin-agent await-turn $jobB; devin-agent status $jobB    # bg task 2
devin-agent await-turn $jobC; devin-agent status $jobC    # bg task 3

# Each notifies you independently the instant its agent finishes
# Quit each when done reading results
devin-agent send $jobA "/quit"
devin-agent send $jobB "/quit"
devin-agent send $jobC "/quit"
```

### Sequential Implementation

```bash
# Phase 1
devin-agent start "Implement Phase 1 of PRD" --map       # -> job1
devin-agent await-turn $job1                              # blocks until done
devin-agent status $job1                                  # review result
devin-agent send $job1 "/quit"

# Phase 2 (after Phase 1 verified)
devin-agent start "Implement Phase 2 of PRD" --map       # -> job2
devin-agent await-turn $job2
devin-agent status $job2
devin-agent send $job2 "/quit"
```

## Quality Gates

Before marking any stage complete:

| Stage | Gate |
|-------|------|
| Research | Findings documented in agents.log |
| Synthesis | Clear understanding, contradictions resolved |
| PRD | User reviewed and approved |
| Implementation | Typecheck passes, no new errors |
| Review | Security + quality checks pass |
| Testing | Tests written and passing |

## Error Recovery

### Agent Stuck

```bash
devin-agent jobs --json           # check status
devin-agent capture <jobId> 100   # see what's happening
devin-agent send <jobId> "Status update - what's blocking you?"
devin-agent kill <jobId>          # only if truly stuck
```

### Agent Didn't Get Message

If `devin-agent send` doesn't seem to work:
1. Check agent is still running: `devin-agent jobs --json`
2. Agent might be "thinking" - wait a moment
3. Try sending again with clearer instruction
4. Attach directly: `tmux attach -t devin-agent-<jobId>`

### Implementation Failed

1. Check the error in output
2. Don't retry with the same prompt
3. Mutate the approach - add context about what failed
4. Consider splitting into smaller tasks

## Post-Compaction Recovery

After Claude's context compacts, immediately:

```bash
# Check agents.log for state
# (Read agents.log in project root)

# Check running agents
devin-agent jobs --json
```

Read the log. Understand current stage. Resume from where you left off.

## When NOT to Use This Pipeline

Basically never. Devin agents are the default for all execution work.

**The ONLY exceptions:**
- The user explicitly says "you do it" or "don't use Devin"
- Pure conversation/discussion (no code, no files)
- You need to read a single file to understand context for the conversation

**Everything else goes to Devin agents**, including:
- "Simple" single file changes
- "Quick" bug fixes
- Tasks you think you could handle yourself

Why? Because:
1. Your job is orchestration, not implementation
2. Devin agents are specialized for coding work
3. This frees you to continue strategic discussion with the user
4. It's more efficient - agents work while you talk
