# Change settings in a settings view or by a sentence

## Goal
See and change draft's settings inside draft, in a settings view and by a sentence such as "use Kiro Remote at https://…", instead of editing config.json by hand.

## Notes
- Today the settings are config.json in the data directory (for the dev build: ~/Library/Application Support/@nikovirtala/draft-desktop/) or environment variables: kiroRemoteUrl, agent, agents, arkSources, artifactUrl, gitRemotes.
- Found on 2026-11-22: without kiroRemoteUrl, draft leaves Kiro Remote's MCP server out of the agent's session and says nothing. The agent in the longplay context had only the folder's own adr server.
- The sentence works like "open longplay": draft recognises it, posts it for people only, and it becomes one action for the person to confirm. The agent can suggest a change but can't make one: changing a setting is person-only, like accepting.
- The view is a block like any other (panel or window). It lists each setting with where its value comes from (environment, config.json or default). A value from the environment is shown, but changing it needs a restart without the variable, so the view says that.
- No secrets here: the Kiro Remote sign-in stays in safeStorage and ANTHROPIC_API_KEY in the environment. A setting shows whether a secret is present, never its value.
- A change is written atomically to config.json, recorded as an event (settings.changed with the key and the person, not the value), and applies to new agent sessions; draft says when a session or a restart is needed.

## Done when
- Every setting in config.json can be seen and changed in the view, and by a sentence the person confirms.
- The agent can't change a setting: proved like the other person-only transitions.
- With no Kiro Remote URL, the main conversation says the agent has no Kiro Remote tools and offers to set it.
- config.json stays the store, and editing it by hand still works.
