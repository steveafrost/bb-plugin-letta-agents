# Letta Agents for BB

A sidebar roster for local Letta agents, with avatars, activity indicators, and actions to start or resume BB chats through the ACP adapter. This is not a standalone Letta server or an ACP provider: it reads a local Letta container and synchronizes custom-agent entries in an installed adapter.

## Requirements and setup

- BB **>=0.46** and Plugin SDK **>=0.6.49**; development dependency is pinned to SDK **0.6.49**. These are manifest constraints, not a claim that every newer version has been tested.
- The enabled ACP adapter plugin **`bb--provider-acp-next`**, including its `customAgents` setting. Generated providers must be available before a chat can start.
- Docker available to the plugin backend, permission to access its daemon, and a running local container with **Node** and the expected letta-code files. The plugin does not provision Docker, Letta, an app-server, a project, a host, or a workspace provider.
- Node/npm and `npx` on the **ACP execution host**. The adapter launches `npx -y @letta-ai/letta-acp@0.1.10`; initial resolution may require registry access.
- A running Letta app-server reachable from that ACP host, with a matching token.

Configure the following in Letta Agents settings before starting a new chat. Use IDs from your own BB installation; none are portable hard-coded defaults.

| Setting | Default | Meaning |
| --- | --- | --- |
| `projectId` | empty | Required existing BB project ID (`bb project list` can identify projects). |
| `hostId` | empty | Required existing host for the workspace and ACP process. |
| `environmentProviderId` | empty | Required installed workspace provider ID; `personal-workspace` is only an example where installed. |
| `container` | `letta` | Local Docker container name or ID. |
| `dockerExecutable` | `docker` | Executable on PATH or an absolute executable path, not a shell command. |
| `appServerUrl` | `ws://127.0.0.1:4500` | Endpoint as seen from the ACP execution host, not necessarily from the plugin backend. |
| `allowUnrestricted` | `false` | Explicit opt-in to unrestricted Letta tools and full BB permissions. |
| `showAgentsInProviderPicker` | `false` | UI-only picker visibility; providers stay enabled. |

The container layout is currently fixed, not configurable:

- `/root/.letta/lc-local-backend/agents/*.json`: roster records, read by Node inside the container. Records contain an immutable `id`, a nonempty `name`, optional nullable `description`, and optional integer `avatarVersion` (default 1). At most 500 agents are accepted.
- `/root/.letta/app-server.token`: app-server token, read inside the container.
- `/root/.letta/lc-local-backend/avatars/<agent-id>-128.png`: optional PNG avatars. Missing or invalid avatars fall back to initials.

A different container user/home layout needs source changes or compatible mounts. Merely changing `appServerUrl` does not enable remote roster discovery: roster and token reads still use local Docker access.

### ACP version pin

The generated command deliberately pins **`@letta-ai/letta-acp@0.1.10`** because **0.1.11 has a known stream-hang issue**. This is not evidence that modern versions have been tested or that all newer versions are affected. Changing the pin requires separate compatibility and live-chat verification.

## Security and permissions

**Docker daemon/socket access is administrator-level trust.** Only use this with a trusted local container and trusted BB/plugin operators. Container-name validation, argument-array subprocess execution, and a fixed roster script reduce injection risks; they do not sandbox Docker access.

The token is copied into **plaintext ACP `customAgents` settings** as `env.LETTA_APP_SERVER_TOKEN`, then supplied to the ACP process through its environment. It is not placed in process argv. Plugin logs and surfaced subprocess/SDK errors withhold sensitive command output/settings rather than printing the token. This does not encrypt the settings or hide the environment from privileged host operators, the adapter, or its child process; protect settings, backups, and host access accordingly.

Use **`ws://` only on a trusted local network**. Use **`wss://` outside that boundary** to protect credentials and traffic in transit. URL validation accepts either scheme and rejects embedded credentials, query strings, and fragments; it does not enforce TLS or verify the endpoint's operational safety.

By default, generated ACP entries use Letta **`standard`** permission mode and newly spawned BB threads use **`auto`** approvals. Enabling `allowUnrestricted` changes synchronized entries to Letta **`unrestricted`** and newly spawned threads to BB **`full`** permissions. Existing threads retain their BB permission mode; toggling this setting does not retroactively grant or revoke it, or guarantee reconfiguration of an already-running ACP session.

## Identity, synchronization, and retention

Roster identity comes from the immutable Letta agent ID, not its mutable display name. New provider IDs use `letta-id-` plus a truncated SHA-256 of that ID; BB exposes them with an `acp-` prefix. The persisted `provider-identities:v2` mapping preserves established IDs, including historical name-based provider IDs discovered by matching the remote backend and immutable agent ID. Renaming an agent does **not** force a provider rename. Duplicate IDs and ownership collisions stop synchronization rather than overwrite another agent.

Synchronization replaces matching owned entries and appends new ones. **Unrelated ACP entries are never intentionally removed. Entries for removed or temporarily missing agents are intentionally retained**, as are historical mappings: clean them up manually in ACP settings after checking existing threads. An incomplete roster must not destroy providers.

Refreshes run non-blockingly at startup, on relevant settings changes, and every five minutes. Roster requests refresh when not ready or older than one minute; the UI polls every minute. A source-matched cached roster can remain visible with a warning after failure. Chat start requires successful roster readiness rather than silently trusting stale configuration.

Within this plugin, overlapping syncs and same-agent chat starts are coalesced. Before writing adapter settings, the plugin re-reads `customAgents` and rejects a detected concurrent change. **The public settings API provides no compare-and-swap (CAS).** A cross-plugin or manual edit between that final read and write can still race and be overwritten. Avoid concurrent adapter-settings edits and retry after a conflict; this is not transactional cross-plugin synchronization.

Chat references are stored by immutable agent ID, with a limited historical name-key fallback. An unarchived saved thread is reused only when its provider matches. An uncertain lookup fails safely without spawning a duplicate; archived or deleted threads may lead to a new chat; a provider mismatch stops with an error rather than silently creating a replacement.

## Picker compatibility workaround

There is no upstream supported API here for hiding an enabled provider only from the picker. The default hiding behavior injects **DOM-dependent CSS**, targeting dialog buttons by current classes and title text. It is a compatibility workaround, not provider disablement or an access-control boundary. BB markup changes may stop it working.

When an unrelated provider has the same display name, hiding **fails open** so the unrelated entry is not hidden; the Letta entry may remain visible too. Enable `showAgentsInProviderPicker` to bypass the workaround.

## Current limits and verification status

This implementation is tied to the local Docker layout, the adapter's custom-agent settings, experimental BB sidebar APIs, and current picker markup. It is not a general Letta Cloud connector. It does not automatically remove retired providers or migrate existing thread permissions.

**Exact clean-install verification and end-to-end live chat/streaming verification are still pending.** Source behavior and declared version floors are not a successful installation or chat test. This document makes no release, publication, marketplace acceptance, or fully tested compatibility claim.
