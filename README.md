# Letta Agents for BB

A sidebar roster for local Letta agents, with avatars, activity indicators, and actions to start or resume BB chats through the ACP adapter. This is not a standalone Letta server or an ACP provider: it reads a local Letta container and synchronizes custom-agent entries in an installed adapter.

## Release status and installation

Release **0.3.32** is distributed from the public GitHub repository under MIT. Use the release tag rather than an unversioned development checkout:


```sh
git clone --branch v0.3.32 --depth 1 https://github.com/steveafrost/bb-plugin-letta-agents.git
cd bb-plugin-letta-agents
bb plugin install .
```

Installing runs trusted third-party code. Review the source and security notes first. Configure the settings below for your installation; installation alone does not provision the dependencies or enable new chats. Community marketplace availability depends on review and acceptance of the submission.

## Requirements and setup

- BB **>=0.46** and Plugin SDK **>=0.6.49**; development dependency is pinned to SDK **0.6.49**. These are manifest constraints, not a claim that every newer version has been tested.
- The enabled ACP adapter plugin **`provider-acp`**, including its `customAgents` setting. Generated providers must be available before a chat can start.
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

By default, generated ACP entries use Letta **`standard`** permission mode and newly spawned BB threads use **`auto`** approvals. Enabling `allowUnrestricted` changes synchronized entries to Letta **`unrestricted`** and newly spawned threads to BB **`full`** permissions. Existing threads retain their BB permission mode; toggling this setting does not retroactively grant or revoke it, or guarantee reconfiguration of an already-running ACP session. **Retained providers absent from the current roster are not rewritten, including their permission mode.** Turning unrestricted mode off is therefore not a global revocation: review absent providers and existing sessions explicitly before relying on that restriction.

## Identity, synchronization, and retention

Roster identity comes from the immutable Letta agent ID, not its mutable display name. New provider IDs use `letta-id-` plus a truncated SHA-256 of that ID; BB exposes them with an `acp-` prefix. The persisted `provider-identities:v2` mapping preserves established IDs, including historical name-based provider IDs discovered by matching the remote backend and immutable agent ID. Renaming an agent does **not** force a provider rename. Duplicate IDs and ownership collisions stop synchronization rather than overwrite another agent.

Synchronization updates matching owned entries while preserving opaque settings/environment fields, and appends new ones. A saved identity that disagrees with an existing provider requires explicit migration; it never silently adds a second identity. **Unrelated ACP entries are never intentionally removed. Entries for removed or temporarily missing agents are intentionally retained**, as are historical mappings: clean them up manually in ACP settings after checking existing threads. An incomplete roster must not destroy providers.

Refreshes run non-blockingly at startup, on relevant settings changes, and every five minutes. Roster requests refresh when not ready or older than one minute; the UI polls every minute. A source-matched cached roster can remain visible with a warning after failure. An existing saved chat may resume without Docker/ACP synchronization when cached roster and persisted provider source match the current configuration and thread ownership is verified. New or replacement chats still require successful current-generation synchronization and explicit targets.

Within this plugin, overlapping syncs and same-agent chat starts are coalesced. Before writing adapter settings, the plugin re-reads `customAgents` and rejects a detected concurrent change. **The public settings API provides no compare-and-swap (CAS).** A cross-plugin or manual edit between that final read and write can still race and be overwritten. Avoid concurrent adapter-settings edits and retry after a conflict; this is not transactional cross-plugin synchronization.

Chat references are stored by immutable agent ID, with a limited historical name-key fallback. Successful creations are retained in memory if saving their reference fails, preventing duplicate creation on retry within the same plugin runtime. This is not durable idempotency across a restart after a failed storage write. An unarchived saved thread is reused only when its provider matches. An uncertain lookup fails safely without spawning a duplicate; only ownership-verified archived or deleted threads may lead to a new chat; a provider mismatch stops with an error rather than silently creating a replacement.

## Sidebar thread nesting

The Threads section nests visible BB child threads beneath their `parentThreadId`,
including grandchildren and deeper descendants. Use the chevron beside a parent
row to expand or collapse its children without opening the conversation. Branches
start collapsed; navigating to a child reveals its ancestors. Disclosure choices
survive sidebar remounts within the current frontend session, but not app reloads.
Root threads retain section ordering; descendants follow their parent even when
assigned to another section. Threads whose parent is absent from the visible list
remain accessible as roots. Agent-owned conversations and delegated tasks retain
their separate Agents-section behavior. Provider-internal subagents that do not
create BB threads are not included.

## Sidebar status dots

An agent row's dot aggregates only the threads the sidebar renders for that agent: its **saved chat** — the thread clicking the row opens — and the **dispatched tasks** nested beneath it. Provider identity alone does not qualify a thread, because provider-owned threads that are neither are hidden from the list and would otherwise raise an unread or working dot with no row to click and clear it. A thread left over from an earlier probe or migration can still occupy a provider; it no longer affects the row.

The saved chat is resolved server-side: `chat_start` and `agents_list` share one `savedChatId` lookup, and `agents_list` reports it as `chatThreadId` so the sidebar scopes its dot to exactly the thread a click opens. The two callers treat that value differently by design. `chat_start` treats it as a **claim**: it loads the thread and rejects a provider mismatch before resuming. `agents_list` only forwards the pointer — loading every agent's thread on every poll would cost one SDK call per agent — and the sidebar re-checks ownership before drawing a dot.

`chatThreadId` is constrained at the RPC boundary to the BB thread-id shape, so a stale or hand-edited plugin-KV row is reported as `null` rather than reaching the sidebar as a link target. The saved chat must also belong to the agent's own provider (or a recorded alias) before it earns a dot; a dispatched task on another provider is admitted, because `chat_start` permits that.

## Picker compatibility workaround

There is no upstream supported API here for hiding an enabled provider only from the picker. The default hiding behavior injects **DOM-dependent CSS**, targeting dialog buttons by current classes and title text. It is a compatibility workaround, not provider disablement or an access-control boundary. BB markup changes may stop it working.

When an unrelated provider has the same display name, hiding **fails open** so the unrelated entry is not hidden; the Letta entry may remain visible too. Enable `showAgentsInProviderPicker` to bypass the workaround.

## Current limits and verification status

This implementation is tied to the local Docker layout, the adapter's custom-agent settings, experimental BB sidebar APIs, and current picker markup. It is not a general Letta Cloud connector. It does not automatically remove retired providers or migrate existing thread permissions.

Release checks passed 54 automated tests, TypeScript checking, and the BB plugin build. Basic saved-chat navigation was checked in the running app; the maintainer confirmed the remaining live workflow and visual checks. These are local results, not a compatibility guarantee for other installations. The adapter remains pinned to 0.1.10; other versions are unverified.

## Development and reporting issues

Use a recent Node.js version with native TypeScript stripping (the current local checks use Node **26.4.0**) and npm. A native build toolchain may be needed for the SDK test harness's SQLite dependency.

```sh
npm ci
npm test
npm run typecheck
```

Before release, also validate a clean installation, the BB frontend build, and the live chat workflow. Do not equate unit tests with streaming compatibility. Automated CI is not yet established for the public repository.

When reporting issues, include BB, Node, plugin and ACP versions, operating system, sanitized reproduction steps, and whether this is a new or saved chat. **Never attach ACP settings exports, tokens, process environments, private conversations, or unsanitized screenshots.** Report suspected credential exposure privately rather than posting it in a public issue; rotate affected credentials using your infrastructure's procedure.

Licensed under the [MIT License](LICENSE).
