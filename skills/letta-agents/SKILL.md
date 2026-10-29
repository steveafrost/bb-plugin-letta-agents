---
name: letta-agents
description: Configure or troubleshoot the Letta Agents sidebar plugin, its local Docker roster, and ACP chat integration.
---

# Letta Agents

This plugin displays local Letta agents in BB's sidebar and synchronizes their providers through the enabled `provider-acp` adapter. It does not provision Letta or expose a `bb letta` command.

Read the plugin README before setup or troubleshooting. Configure `container`, `dockerExecutable`, and `appServerUrl` for the user's installation. `acpCommand`, `acpArgs`, and `modelCatalogListArgs` control the generated ACP launch and model-catalog commands; leave them at their defaults unless the user runs a different ACP adapter build, and set `modelCatalogListArgs` to a JSON array only when the adapter exposes a list command. New chats additionally require existing `projectId`, `hostId`, and `environmentProviderId` values. Never copy another installation's IDs.

The plugin backend reads the fixed `/root/.letta/` container layout using local Docker. The ACP execution host needs Node/npm, `npx`, and network access to the app-server. A remote WebSocket endpoint alone does not enable remote roster discovery.

## Safety

- Never print the token, ACP `customAgents` values, or process environments. The adapter settings contain a plaintext token.
- Docker access is administrator-level trust. Ask before executing diagnostic container commands or changing live settings.
- Keep `allowUnrestricted` off unless explicitly approved. Turning it off does not revoke existing thread permissions or rewrite providers absent from the roster.
- Do not delete providers, change saved identities, or recreate a conversation to bypass lookup/ownership errors. Restore connectivity and verify ownership first.
- Settings updates are not atomic across plugins. Avoid concurrent adapter edits.
- The provider-picker hiding behavior is a fail-open CSS workaround. `showAgentsInProviderPicker` disables it without disabling providers.

## Troubleshooting

For stale roster warnings, check Docker access, container layout, and app-server connectivity without displaying credentials. For new-chat target errors, obtain the user's existing BB project, host, and workspace-provider IDs. A saved, ownership-verified conversation may resume despite an unavailable backend; a new chat requires current synchronization.

Use `npm test` and `npm run typecheck` for isolated source checks. These do not establish live sidebar, streaming, or installation correctness. Follow BB's browser and plugin authoring guidance for live verification; ask before build/reload or release operations.
