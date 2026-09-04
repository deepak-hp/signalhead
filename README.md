# signalhead

A traffic light that floats on top of everything and tells you what your AI
coding agents are doing.

```
● red      an agent stopped and needs you (permission, question, choice)
● yellow   an agent is working
● green    an agent finished and is ready for the next task
```

Stop alt-tabbing to check whether the agent is still thinking or has been waiting
on you for five minutes. Glance at the corner of the screen instead.

Works on **macOS, Windows and Linux**, with **any** agent — through the agent's
own hooks where they exist, a watched terminal where they don't, and one line of
shell for everything else.

---

## Install

```bash
npm install -g signalhead
sig setup      # fetches the Electron runtime for the floating window
sig start
```

Or without installing anything globally:

```bash
npx signalhead start
```

`setup` is a separate step because npm 11 blocks package install scripts by
default, and that script is what downloads the Electron binary. Skip it and
`sig start --browser` still gives you the same light in a browser tab.

From a clone:

```bash
git clone https://github.com/deepak-hp/signalhead
cd signalhead && npm install && npm run setup
node src/cli.js start
```

---

## Use it

```bash
sig start              # server + floating light
sig install claude     # wire into Claude Code — takes effect immediately
```

Drag the light anywhere; it remembers where you put it. Hover for a small
toolbar: switch between the tall housing and a slim bar, collapse to a single
dot, or quit. Clicks pass straight through to whatever is underneath, except on
the light itself.

```bash
sig status             # what the lights say right now
sig clear              # forget sessions left behind by a crashed agent
sig doctor             # check this machine is wired up correctly
sig demo               # cycle the lamps to check it works
sig stop               # shut it all down
```

---

## Connecting your agents

Three tiers, best first.

### 1. The agent's own hooks — exact

```bash
sig install claude     # ~/.claude/settings.json   (--scope project for one repo)
sig watch codex        # tails Codex's session log; no config touched
```

| Agent | Lamps | Mechanism |
|---|---|---|
| Claude Code | all three, per session | nine lifecycle hooks |
| Codex | all three, per session | session rollout log |
| Codex (alternative) | red + green only | its `notify` program |

Claude Code picks the hooks up without a restart.

**Codex has two options and the log is the better one.** Codex appends a JSONL
rollout per session under `~/.codex/sessions/YYYY/MM/DD/`, carrying
`task_started`, `task_complete` and approval events — everything needed for all
three lamps, including the "working" signal that `notify` structurally cannot
give you. It covers the editor extension as well as the CLI. Leave
`sig watch codex` running next to `sig start`.

Both installers back up the file they touch, and `sig uninstall claude|codex`
puts things back exactly as they were.

### 2. The wrapper — works with anything

Runs the agent inside a pseudo-terminal, passes every keystroke and byte through
untouched, and reads the lamp off what it prints.

```bash
sig wrap -- gemini
sig wrap -- aider --model sonnet
sig wrap --agent my-bot -- ./my-agent.sh
```

Output flowing means yellow; output stopping on a confirmation prompt means red;
output stopping on nothing in particular means green. Profiles for Gemini CLI,
Aider, Cursor, opencode and Copilot live in
[`src/adapters/patterns.js`](src/adapters/patterns.js) — supporting a new agent
means adding a few regexes there and nothing else.

This is a very good guess, not ground truth. Prefer tier 1 where it exists.

### 3. One line of shell — for everything else

```bash
sig set busy    --agent deploy --detail "building"
sig set waiting --agent deploy --detail "approve prod push?"
sig set idle    --agent deploy
```

or over plain HTTP, from any language:

```bash
curl -s "http://127.0.0.1:4747/set/busy?agent=my-bot&session=$$&detail=thinking"
```

`sig install generic --agent my-bot` prints these ready to paste.

---

## The fuel gauge

A slim vertical bar beside the light showing how much you have left before
something runs out — plan quota, context window, credits, whatever you choose.
It fills from the bottom and turns amber below 40% and red below 15%.

Codex reports real numbers, so it is automatic:

```bash
sig watch codex          # gauge tracks the plan quota from Codex's own logs
sig watch codex --fuel context   # track context window fill instead
```

Anything else can drive it in one line:

```bash
sig fuel 63 --agent claude --label "plan quota"
sig fuel 12 --used --agent ci --label "build minutes"   # --used flips the sense
```

Fuel is always *remaining*, 0–100. With several agents reporting, the gauge shows
the emptiest tank — the thing that will stop you first. It travels on its own
channel, so a quota update never disturbs the lamp.

---

## Several agents at once

Every session gets its own entry, and the lamp shows the one that most wants your
attention: **any red wins, then any yellow, then green.** When more than one
agent is live, a small labelled pill appears under the light for each, so you can
see *which* one is asking.

The window has a fixed width and grows only downward, so the lamp stays at the
same screen pixel no matter how long the status text gets.

---

## Platform support

| | Logic | Floating window |
|---|---|---|
| Windows | verified | verified |
| Linux | verified (Ubuntu 20.04, Node 20) | launches under CI; not visually checked |
| macOS | verified in CI | not visually checked |

The core is plain Node with no runtime dependencies, so the logic is genuinely
portable and CI proves it on all three. The *window* is Electron: transparency,
click-through and always-on-top behave slightly differently per platform, and
only Windows has been looked at by a human. On Linux it needs a compositing
window manager for transparency — without one, use `sig start --browser`.

---

## Is it working on *this* machine?

```bash
npm test        # 42 tests: state logic, adapters, hooks, installer, server, fuel
sig doctor     # this machine: binaries, config paths, live server
```

`npm test` proves the logic. `doctor` proves the wiring — the right Node binary,
hook paths that exist on *this* disk, a reachable server. Those are what differ
between machines, and exactly what you cannot diagnose from a lamp that just sits
there.

CI runs the suite on Windows, macOS and Linux across Node 20/22/24, plus a CLI
smoke test, a hook install/uninstall round trip, and a headless overlay launch —
see [.github/workflows/test.yml](.github/workflows/test.yml). To run the Linux
checks yourself: `npm run test:linux`.

### Seeing red on purpose

Yellow and green show up on their own within seconds of using an agent. Red is
the one worth deliberately checking, since it is the whole point of the tool.

**Ask Claude Code something it has to stop and ask you about** — a question with
options, or a decision it cannot make alone. The lamp goes red and stays red
until you answer, however long that takes.

The obvious-looking approach — "run a command that needs permission" — is
unreliable, because a session with permissions already granted never prompts, so
the `Notification` hook never fires and the lamp correctly stays yellow. That is
not a bug, and chasing it will waste your time. A question that genuinely blocks
on a human always fires.

For a wrapped agent, `sig wrap -- <cmd>` goes red whenever output stops on
something that looks like a confirmation prompt.

---

## How it fits together

```
agent hooks ─┐
sig watch ──┼──> localhost:4747 ──SSE──> overlay window (Electron)
sig wrap  ──┤      state store             or a browser tab
curl / set ──┘
```

| | |
|---|---|
| [`src/server.js`](src/server.js) | HTTP + SSE, bound to loopback only |
| [`src/store.js`](src/store.js) | sessions, four states, fuel, the priority rules |
| [`src/overlay/`](src/overlay/) | the window: transparent, always-on-top, click-through |
| [`src/hooks/`](src/hooks/) | per-agent hook receivers |
| [`src/adapters/`](src/adapters/) | installers, Codex log watcher, pty wrapper, patterns |
| [`src/doctor.js`](src/doctor.js) | per-machine diagnosis |

The overlay page is served by the same server, so `http://127.0.0.1:4747/` is a
working traffic light in any browser — handy for a second monitor or an OBS
browser source.

Nothing leaves your machine. The server listens on loopback only and holds
nothing but the current state of each session.

Settings live in `~/.signalhead/config.json` — port, window position,
theme, `staleBusyMs`, and `clickThrough` if you would rather the window swallow
clicks.

---

## Autostart

**macOS** — a LaunchAgent at `~/Library/LaunchAgents/com.sig.plist` running
`node /path/to/src/cli.js start`, then `launchctl load` it.

**Windows** — put a shortcut to [`scripts/signalhead-start.vbs`](scripts/signalhead-start.vbs)
(no console window) in `shell:startup`.

**Linux** — `bash scripts/install-linux-autostart.sh` writes a `.desktop` entry
into `~/.config/autostart`.

---

## When the light looks wrong

Every hook event is appended to `~/.signalhead/hook-events.log` with the
event name, the state it mapped to, and the session it came from:

```
14:51:14.941Z  Stop         -> idle           [cb9bd94d]
14:51:18.095Z  SubagentStop ignored           [cb9bd94d]
```

That log is the fastest way to tell "the agent never sent anything" apart from
"the agent sent something I mapped wrong" — different bugs, indistinguishable
from the lamp alone. `SIGNALHEAD_LOG=0` turns it off.

Two behaviours worth knowing, both learned the hard way:

- **Unknown events are ignored, never guessed.** An earlier version defaulted
  anything unrecognised to `busy`, so one unexpected payload pinned the lamp
  yellow with no way to see why.
- **A green session nobody touches for `idleTtlMs` (default 30 min) is
  forgotten.** An agent that crashes or is force-quit never sends its "session
  ended" event, so its pill would otherwise sit there for hours claiming to be
  ready when nothing is running. If it is still alive, its next event brings it
  straight back. `sig clear` does it immediately. A **red** session is never
  aged out, however long it waits.
- **A `busy` session that goes quiet for `staleBusyMs` (default 60s) falls back
  to green.** A working agent emits events constantly, so a long silence almost
  always means it finished without saying so — and some agents have no reliable
  "turn ended" event at all. If it really is still working, its next event
  corrects the lamp immediately. `sig status` marks these
  `no finish signal — assumed done`.

---

## Known limits

- The wrapper's red is pattern matching. A CLI phrasing its prompt unusually
  shows green instead of red until you add a regex to `patterns.js`.
- Codex approval → red is inferred from the event naming convention; every other
  Codex path is verified against real session logs.
- The stale-busy fallback can show green early during long silent thinking. It
  self-corrects on the next event.
- Electron is a ~140 MB download. `--browser` avoids it entirely.

---

MIT licensed. Contributions welcome — especially agent profiles in
`patterns.js` and a look at the window on macOS.
