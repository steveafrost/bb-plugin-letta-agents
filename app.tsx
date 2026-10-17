// bb-plugin-letta-agents — frontend entry.
//
// Replaces the sidebar's thread list with one unified view: a list of agents
// section on top, the normal threads below. React and @get-bb/plugin-sdk/app
// are provided by the BB app at load time.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import {
  definePluginApp,
  // Aliased because JSX lowercases identifiers: an unaliased
  // "experimental_*" component would parse as an intrinsic element.
  experimental_Icon as PluginIcon,
  experimental_ThreadActionsContextMenu as ThreadActionsContextMenu,
  experimental_ThreadActionsMenu as ThreadActionsMenu,
  experimental_useProviders,
  experimental_useSidebarThreads,
  experimental_useThreadActions,
  ThreadTitle,
  useBbNavigate,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import type {
  PluginSidebarThread,
  PluginThreadActionTarget,
  PluginThreadListProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { cn } from "@/lib/utils";
import { providerPickerCss } from "./lib/picker";
import { agentTasks } from "./lib/agent-tasks";

type Agent = {
  id: string;
  name: string;
  providerId: string;
  providerIds?: string[];
  description: string;
  avatarVersion: number;
};

function initials(name: string): string {
  return name
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

// Preserve the last successful display across sidebar navigation/remounts.
let rosterSnapshot: Agent[] | null = null;
let avatarSnapshot: Record<string, string> = {};

/** Agent roster + optional avatars. RPC has no transport abort API; cancel locally. */
function useAgents() {
  const rpc = useRpc<typeof rpcContract>();
  const [agents, setAgents] = useState<Agent[] | null>(() => rosterSnapshot);
  const [avatars, setAvatars] = useState<Record<string, string>>(() => avatarSnapshot);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const lifetime = useRef<AbortController | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);
  const refetch = useCallback(() => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || inFlight.current) return;
    setLoading(true);
    const load = async () => {
      try {
        const result = await rpc.call("agents_list", null);
        if (signal.aborted) return;
        rosterSnapshot = result.agents;
        setAgents(result.agents);
        setError(null);
        setWarning(result.warning ?? (result.stale ? "Showing cached agents; roster refresh is unavailable." : null));
        const next: Record<string, string> = {};
        let cursor = 0;
        // Four workers bound concurrency, including while the roster refreshes.
        await Promise.all(Array.from({ length: Math.min(4, result.agents.length) }, async () => {
          while (!signal.aborted && cursor < result.agents.length) {
            const agent = result.agents[cursor++]!;
            try {
              const avatar = await rpc.call("avatar_get", { agentId: agent.id, version: agent.avatarVersion });
              if (!signal.aborted && avatar.url) next[agent.id] = avatar.url;
            } catch {
              // Avatar failures never discard the roster or fail the load.
            }
          }
        }));
        if (!signal.aborted) {
          avatarSnapshot = { ...avatarSnapshot, ...next };
          setAvatars(avatarSnapshot);
        }
      } catch (cause) {
        if (!signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    };
    const task = load().finally(() => {
      if (inFlight.current === task) inFlight.current = null;
    });
    inFlight.current = task;
  }, [rpc]);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    // Strict-mode replay (or a client change) must wait for cancelled RPCs too.
    const previous = inFlight.current;
    if (previous) void previous.then(() => { if (!controller.signal.aborted) refetch(); });
    else refetch();
    const timer = setInterval(refetch, 60_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [refetch]);
  return { agents, avatars, error, warning, loading, refetch };
}

function ownsThread(agent: Agent, thread: PluginSidebarThread): boolean {
  return thread.providerId === agent.providerId || (agent.providerIds?.includes(thread.providerId) ?? false);
}

// Indicator literals the builtin thread-list treats as "busy/working"
// (its Ub() active check). A streaming thread maps to "runtime"; the other
// values cover background agents, workflows, and queued-but-active modes.
const WORKING_INDICATORS = new Set([
  "runtime",
  "background-agent",
  "background-command",
  "workflow",
  "plan-mode",
  "goal",
  "working-draft",
]);

// Dot color per non-working indicator, mirroring bb's bundled
// ThreadStatusGlyph tone palette (unread-error/queued-failed → destructive,
// running/success → success, attention (waiting/queued) → warning, like the
// sidebar machines attention badge). Idle stays muted.
// One semantic theme palette shared by agent and thread rows.
const STATUS_DOT_CLASSES = {
  working: "bg-transparent",
  error: "bg-destructive",
  success: "bg-success/70",
  queued: "bg-warning",
  idle: "bg-muted-foreground/40",
};

const INDICATOR_DOT_CLASSES: Record<string, string> = {
  "unread-error": STATUS_DOT_CLASSES.error,
  "queued-failed": STATUS_DOT_CLASSES.error,
  "unread-success": STATUS_DOT_CLASSES.success,
  "queued-waiting": STATUS_DOT_CLASSES.queued,
  "waiting-for-input": STATUS_DOT_CLASSES.queued,
};

/** Dot classes for one thread's indicator; busy pulses, idle stays dim. */
function indicatorDotClass(indicator: string): string {
  if (WORKING_INDICATORS.has(indicator)) return STATUS_DOT_CLASSES.working;
  return INDICATOR_DOT_CLASSES[indicator] ?? STATUS_DOT_CLASSES.idle;
}

/** Aggregated dot state for an agent row (priority: work > error > unread > queued). */
type AgentDotState = "working" | "error" | "success" | "queued" | "idle";

const AGENT_DOT_CLASSES: Record<AgentDotState, string> = STATUS_DOT_CLASSES;

/** Highest-priority dot state across one agent's threads. */
function agentDotState(threads: PluginSidebarThread[]): AgentDotState {
  let state: AgentDotState = "idle";
  const raise = (next: AgentDotState) => {
    const order: AgentDotState[] = ["idle", "queued", "success", "error", "working"];
    if (order.indexOf(next) > order.indexOf(state)) state = next;
  };
  for (const thread of threads) {
    if (WORKING_INDICATORS.has(thread.indicator)) return "working";
    if (thread.indicator === "unread-error" || thread.indicator === "queued-failed") raise("error");
    else if (thread.indicator === "unread-success") raise("success");
    else if (thread.indicator === "queued-waiting" || thread.indicator === "waiting-for-input") raise("queued");
  }
  return state;
}

function WorkingSpinner() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="pointer-events-none absolute -inset-0.5 size-[calc(100%+4px)] animate-spin text-primary motion-reduce:animate-none"
      fill="none"
      aria-hidden
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.2" />
      <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function AgentRow({
  agent,
  avatar,
  state,
  starting,
  onOpen,
}: {
  agent: Agent;
  avatar: string | undefined;
  state: AgentDotState;
  starting: boolean;
  onOpen: () => void;
}) {
  const working = state === "working";
  // Codex-style dot presence: a persistent status dot at the row's right
  // edge — pulsing while the agent (or any of its child threads) is busy,
  // dim and static when idle.
  const title = [
    agent.description || agent.name,
    state === "working" ? "working" : state === "idle" ? "idle" : state,
    starting ? "opening chat…" : null,
  ]
    .filter(Boolean)
    .join(" — ");
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-busy={starting}
      aria-disabled={starting}
      className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
      title={title}
    >
      {avatar ? (
        <img
          src={avatar}
          alt=""
          className={cn(
            "size-5 shrink-0 rounded-full object-cover",
            !working && "opacity-80",
          )}
        />
      ) : (
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
          {initials(agent.name)}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{agent.name}</span>
      <span
        className={cn("relative size-2 shrink-0 rounded-full", AGENT_DOT_CLASSES[state])}
        aria-hidden
      >
        {working && <WorkingSpinner />}
      </span>
    </button>
  );
}

/** The thread a bb thread action/menu is evaluated for, from a sidebar thread. */
function threadActionTarget(thread: PluginSidebarThread): PluginThreadActionTarget {
  return {
    id: thread.id,
    projectId: thread.projectId,
    parentThreadId: thread.parentThreadId,
    archivedAt: thread.archivedAt,
    pinnedAt: thread.pinnedAt,
    sectionId: thread.sectionId,
    isUnread: thread.isUnread,
    status: thread.status,
    environment: thread.environment
      ? { id: thread.environment.id ?? "", path: thread.environment.path }
      : null,
  };
}

// Right edge of one thread row, mirroring bb's bundled row: the status dot
// swaps for a hover-only action strip — an Archive quick action (bb's default
// rowActions) plus the ellipsis that opens bb's full thread actions menu.
// Right-click / touch long-press opens the same menu via the context wrapper.
//
// Zero-jump hover: both layers are absolutely positioned (like bb's bundled
// rows, which overlay hover actions on right padding reserved up front via
// --bb-sidebar-hover-actions-inset). The dot fades out instead of being
// display-toggled, and the row reserves pr-[3.75rem] for the strip, so hover
// changes only opacity/visibility — never layout.
// Hover tooltip for row action buttons: delayed ~2s like a desktop title,
// portal-rendered so it escapes the absolutely positioned hover strip.
function RowTooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={700} skipDelayDuration={300}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            side="top"
            sideOffset={4}
            className="z-50 overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0"
          >
            {label}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}

function ThreadRowControls({ thread }: { thread: PluginSidebarThread }) {
  const target = useMemo(() => threadActionTarget(thread), [thread]);
  const [archive] = experimental_useThreadActions(target, { keys: ["bb--core/archive"] });
  // While the kebab's menu is open the strip must stay mounted: if the pointer
  // leaves the row (e.g. into the chat), the hover-only display:none would
  // unmount the menu's trigger and Radix's popper loses its anchor, visibly
  // repositioning the open menu. The builtin marks its hover-actions container
  // `data-sidebar-hover-actions-open=true` while its menu is open for exactly
  // this reason; mirror that pinning here.
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <>
      <span
        data-sidebar-hover-actions-open={menuOpen ? "true" : undefined}
        className={cn(
          "pointer-events-none absolute right-2 top-1/2 size-2 -translate-y-1/2 rounded-full transition-opacity group-hover/row:opacity-0 group-focus-within/row:opacity-0",
          indicatorDotClass(thread.indicator),
          menuOpen && "opacity-0",
        )}
        aria-hidden
      >
        {WORKING_INDICATORS.has(thread.indicator) && (
          <WorkingSpinner />
        )}
      </span>
      <div
        data-sidebar-hover-actions-open={menuOpen ? "true" : undefined}
        onClick={(event) => {
          // Guard strip gaps: never bubble into the row anchor (its onClick
          // would run navigate.toThread). Matches the builtin's pattern of
          // suppressing clicks on its hover-actions container.
          event.stopPropagation();
        }}
        className={cn(
          "absolute inset-y-0 right-2 z-10 hidden shrink-0 items-center gap-0.5 group-hover/row:flex group-focus-within/row:flex",
          menuOpen && "flex",
        )}
      >
        {archive && (
          <RowTooltip label={archive.action.label}>
            <button
              type="button"
              disabled={archive.action.disabled}
              aria-label={archive.action.label}
              onClick={(event) => {
                // Keep the row's own click from also navigating.
                event.preventDefault();
                event.stopPropagation();
                void archive.action.run();
              }}
              className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <PluginIcon name={archive.action.icon} className="size-3.5" aria-hidden />
            </button>
          </RowTooltip>
        )}
        <ThreadActionsMenu
          thread={target}
          onOpenChange={setMenuOpen}
          trigger={(triggerProps) => (
            <RowTooltip label="More">
              <button
                type="button"
                {...triggerProps}
                aria-label="More thread actions"
                onClick={(event) => {
                  triggerProps.onClick?.(event);
                  // The button sits inside the row's <a href>: without
                  // cancelling the default, the browser follows thread.href
                  // and reloads the whole editor (Radix only stops its own
                  // synthetic bubbling, not the anchor's navigation). This
                  // mirrors the builtin trigger's preventDefault.
                  event.preventDefault();
                  event.stopPropagation();
                }}
                className="flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {/* Vertical kebab (⋯ rotated 90°): the plugin icon set renders
                    "ellipsis" as a lightning bolt, which reads wrong here. */}
                <svg viewBox="0 0 24 24" fill="currentColor" className="size-3.5" aria-hidden>
                  <circle cx="12" cy="5" r="1.9" />
                  <circle cx="12" cy="12" r="1.9" />
                  <circle cx="12" cy="19" r="1.9" />
                </svg>
              </button>
            </RowTooltip>
          )}
        />
      </div>
    </>
  );
}

// Thread and dispatched-task rows navigate in place and retain bb actions.
function ThreadRow({
  thread,
  isActive,
  onNavigate,
  nested = false,
}: {
  thread: PluginSidebarThread;
  isActive: boolean;
  onNavigate: () => void;
  nested?: boolean;
}) {
  const navigate = useBbNavigate();
  const target = useMemo(() => threadActionTarget(thread), [thread]);
  return (
    <ThreadActionsContextMenu thread={target}>
      <a
        href={thread.href}
        onClick={(event) => {
          event.preventDefault();
          if (!isActive) navigate.toThread(thread.id);
          onNavigate();
        }}
        className={cn(
          "group/row relative flex w-full items-center gap-2 text-sm transition-colors hover:bg-accent",
          nested
            ? "py-1 pl-8 pr-[3.75rem] text-xs text-muted-foreground hover:text-foreground"
            : "rounded-md py-1.5 pl-2 pr-[3.75rem] text-foreground/90",
          isActive && "bg-accent",
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          <ThreadTitle threadId={thread.id} />
        </span>
        <ThreadRowControls thread={thread} />
      </a>
    </ThreadActionsContextMenu>
  );
}

// One sidebar: agents section on top, regular threads below. No tabs.
function SidebarList(props: PluginThreadListProps) {
  const { agents, avatars, error: agentsError, warning, loading, refetch } = useAgents();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const { threads, sections } = experimental_useSidebarThreads();
  const [starting, setStarting] = useState<Set<string>>(() => new Set());
  const pending = useRef(new Set<string>());
  const mounted = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const openAgentChat = useCallback(
    async (agent: Agent) => {
      if (!mounted.current || pending.current.has(agent.id)) return;
      pending.current.add(agent.id);
      setStarting(new Set(pending.current));
      setError(null);
      try {
        const result = await rpc.call("chat_start", { agentId: agent.id });
        // Overtake semantics: plain toThread() navigates in place. Passing
        // { split: true } here hands the open to bb's split placement rules
        // (right split by default), which is what flung agent chats into
        // their own pane instead of replacing the current view.
        if (!mounted.current) return;
        if (result.threadId !== props.activeThreadId) navigate.toThread(result.threadId);
        props.onNavigate();
      } catch (cause) {
        if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        pending.current.delete(agent.id);
        if (mounted.current) setStarting(new Set(pending.current));
      }
    },
    [rpc, navigate, props.onNavigate, props.activeThreadId],
  );

  const tasksByAgent = agentTasks(agents ?? [], threads);
  const taskIds = new Set([...tasksByAgent.values()].flat().map(thread => thread.id));

  // Include dispatched children even when they run on another provider.
  const stateByAgentId = new Map<string, AgentDotState>();
  for (const agent of agents ?? []) {
    stateByAgentId.set(
      agent.id,
      agentDotState(
        threads.filter(
          (thread) => !thread.isArchived && (ownsThread(agent, thread) || tasksByAgent.get(agent.id)?.some(task => task.id === thread.id)),
        ),
      ),
    );
  }

  // Agent ownership: a thread belongs to an agent when it runs on that
  // agent's provider. Derived from the loaded roster — while agents === null
  // (still loading) nothing is filtered, matching pre-0.3.14 behavior.
  const isAgentThread = (thread: PluginSidebarThread): boolean =>
    !thread.isArchived && (taskIds.has(thread.id) || (agents ?? []).some((agent) => ownsThread(agent, thread)));

  // Agents open their saved conversation directly; only dispatched tasks nest.
  // Keep owned conversations and nested tasks out of the ordinary Threads list.
  // Ordinary threads remain grouped by section (unsectioned last).
  const sectionIds = new Set(sections.map((section) => section.id));
  const grouped = new Map<string, PluginSidebarThread[]>();
  for (const section of sections) grouped.set(section.id, []);
  const loose: PluginSidebarThread[] = [];
  for (const thread of threads) {
    if (thread.isArchived || isAgentThread(thread)) continue;
    if (thread.sectionId !== null && sectionIds.has(thread.sectionId)) {
      grouped.get(thread.sectionId)!.push(thread);
    } else {
      loose.push(thread);
    }
  }
  const visibleCount = threads.filter((thread) => !thread.isArchived && !isAgentThread(thread)).length;

  const onNavigate = useCallback(() => props.onNavigate(), [props]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-0.5 overflow-y-auto px-1.5 py-2">
      {error !== null && (
        <p role="alert" className="px-2 py-1 text-xs text-destructive">
          {error}
        </p>
      )}
      {(agentsError !== null || warning !== null) && (
        <div className="px-2 py-1 text-xs text-muted-foreground">
          <p role={agentsError ? "alert" : "status"}>
            {agentsError
              ? `${agentsError}${agents !== null ? " — showing the last loaded roster." : ""}`
              : warning}
          </p>
          <button type="button" onClick={refetch} disabled={loading} className="mt-1 underline disabled:opacity-60">
            {loading ? "Refreshing…" : "Retry"}
          </button>
        </div>
      )}
      <div className="px-2 pt-1 pb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        Agents
      </div>
      {agents === null ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          {loading ? "Loading agents…" : "Unable to load agents."}
        </p>
      ) : agents.length === 0 ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          No agents found — is the <code>letta</code> container running?
        </p>
      ) : (
        agents.map((agent) => (
          <div key={agent.id}>
            <AgentRow
              agent={agent}
              avatar={avatars[agent.id]}
              state={stateByAgentId.get(agent.id) ?? "idle"}
              starting={starting.has(agent.id)}
              onOpen={() => void openAgentChat(agent)}
            />
            {(tasksByAgent.get(agent.id) ?? []).map(thread => (
              <ThreadRow
                key={thread.id}
                thread={thread}
                nested
                isActive={props.activeThreadId === thread.id}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        ))
      )}
      <div className="my-1 border-t border-border" />
      <div className="px-2 pb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        Threads
      </div>
      {sections.map((section) =>
        grouped.get(section.id)!.map((thread) => (
          <ThreadRow
            key={thread.id}
            thread={thread}
            isActive={props.activeThreadId === thread.id}
            onNavigate={onNavigate}
          />
        )),
      )}
      {loose.map((thread) => (
        <ThreadRow
          key={thread.id}
          thread={thread}
          isActive={props.activeThreadId === thread.id}
          onNavigate={onNavigate}
        />
      ))}
      {visibleCount === 0 && (
        <p className="px-2 py-1 text-xs text-muted-foreground">No conversations yet.</p>
      )}
    </div>
  );
}

// App-wide owner: settings/provider hooks stay reactive even when the sidebar
// is unmounted. React owns the style node, so reload/disable removes it.
// UI-only workaround: BB currently has no picker-only visibility API. Keep
// this scoped to the inspected provider-icon row, never sidebar buttons.
function ProviderPickerVisibility() {
  const { values } = useSettings();
  const { providers } = experimental_useProviders();
  if (!values || values.showAgentsInProviderPicker === true) return null;
  const css = providerPickerCss(providers, typeof CSS !== "undefined" ? CSS.escape : undefined);
  return css ? <style data-letta-provider-picker>{css}</style> : null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "provider-picker-visibility",
    component: ProviderPickerVisibility,
  });
  app.slots.experimental_threadList({
    id: "agents-above-threads",
    title: "Agents sidebar",
    description: "Agents as a section above the thread list.",
    component: SidebarList,
  });
});
