# tldr-window

A Claude Code mod that answers "what is this window for?" at a glance.

After each turn, it asks the session's own model one side question over the cached transcript (`$.model.fork`). That keeps the cost mostly to cache-read tokens. The answer becomes a short TL;DR:

- **Title**: 3 to 6 words
- **Goal**: what you're trying to get done
- **Now**: where things stand
- **Next**: the next step, or what Claude is waiting on you for

## Where it shows

| Where | When |
| --- | --- |
| Pane docked on the right | Fullscreen terminal. It opens by itself from 144 columns, or from 110 once you've opened it yourself with `/tldr`. |
| 2-row block above the prompt | Non-fullscreen terminal that's wide enough |
| One dim line above the prompt | When no pane is seated (narrow terminal, or you closed the pane) |
| Session title | Set on your next prompt, so `/resume` and the window name say what it's doing. Toggle with `retitle_session`. |
| "Other windows" list | Inside the pane: every other open window's TL;DR, shared through `$.store` |

`/tldr` opens the pane and refreshes it. It works while Claude is busy. Press `r` or **Refresh** in the pane to refresh too.

## Options (`/config`)

- `engine`: one of two values.
  - `fork` (default): the session's model over its cached transcript. Full context, billed as cache reads.
  - `haiku`: Haiku over a condensed digest of recent messages. Uses less of the transcript.
- `refresh`: one of two values.
  - `every-turn` (default): refresh after each turn.
  - `manual`: refresh only on `/tldr` or the button.
- `retitle_session`: on by default. Turn it off to keep names you set with `/rename`.

## Run it

```bash
claude --plugin-dir ~/code/claude-mod-tldr-window
```

To load it in every session, including the desktop app, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.

## Develop

```bash
claude plugin validate .
claude plugin test .
```

Requires Claude Code v2.1.287 or later. Built on 2.1.288.
