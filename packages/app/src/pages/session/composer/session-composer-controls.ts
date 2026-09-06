import { base64Encode } from "@mongolgpt/core/util/encode"
import { createQuery, type QueryClient } from "@tanstack/solid-query"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { type Accessor, createMemo } from "solid-js"
import type { PromptBootstrapState, PromptInputControls } from "@/components/prompt-input"
import type { PromptProjectControls } from "@/components/prompt-project-selector"
import { useDirectoryPicker } from "@/components/directory-picker"
import { useGlobal } from "@/context/global"
import { useLayout } from "@/context/layout"
import { useLocal } from "@/context/local"
import { useServerSync, type QueryOptionsApi } from "@/context/server-sync"
import { useServerSDK } from "@/context/server-sdk"
import { serverName, ServerConnection, useServer } from "@/context/server"
import { useSDK } from "@/context/sdk"
import { useSettings } from "@/context/settings"
import { useSync } from "@/context/sync"
import { useTabs } from "@/context/tabs"
import { useProviders } from "@/hooks/use-providers"
import { pathKey } from "@/utils/path-key"
import type { Agent } from "@mongolgpt/sdk/v2/client"

export function createPromptInputController(input: {
  sessionKey: Accessor<string>
  sessionID: Accessor<string | undefined>
  queryOptions: Pick<QueryOptionsApi, "agents" | "providers">
}) {
  const layout = useLayout()
  const local = useLocal()
  const providers = useProviders()
  const serverSync = useServerSync()
  const settings = useSettings()
  const sync = useSync()
  const sdk = useSDK()
  const view = layout.view(input.sessionKey)
  // The route shell has its own cache; observe the cache that owns the actual directory catalogs.
  const queryClient = () => serverSync().queryClient
  const agentsQuery = createQuery(() => input.queryOptions.agents(pathKey(sdk().directory)), queryClient)
  const globalProvidersQuery = createQuery(() => input.queryOptions.providers(null), queryClient)
  const providersQuery = createQuery(() => input.queryOptions.providers(pathKey(sdk().directory)), queryClient)

  const retryBootstrap = async () => {
    const targetSync = sync()
    const directory = pathKey(sdk().directory)
    await retryPromptBootstrap({
      queryClient: queryClient(),
      agents: agentsQuery.isError ? input.queryOptions.agents(directory) : undefined,
      providers: providersQuery.isError ? input.queryOptions.providers(directory) : undefined,
      globalProviders: globalProvidersQuery.isError ? input.queryOptions.providers(null) : undefined,
      setAgents: (value) => targetSync.set("agent", value),
    })
  }

  const bootstrap = createMemo<PromptBootstrapState>(() => {
    const dependencies = [
      { dependency: "agent", query: agentsQuery },
      { dependency: "directory-models", query: providersQuery },
      { dependency: "server-models", query: globalProvidersQuery },
    ] as const
    // Reading Solid Query data before pending state would suspend the whole composer.
    // Cached successful data remains usable during background catalog refreshes.
    const loading = dependencies.find(({ query }) => query.isPending)
    if (loading) return { status: "loading", dependency: loading.dependency, retry: retryBootstrap }

    const failed = dependencies.find(({ query }) => query.isError && query.data === undefined)
    if (failed) {
      return {
        status: "error",
        dependency: failed.dependency,
        timedOut: failed.query.error instanceof Error && failed.query.error.name === "TimeoutError",
        retry: retryBootstrap,
      }
    }
    return { status: "ready" }
  })

  return createMemo<PromptInputControls>(() => ({
    agents: {
      available: sync().data.agent,
      options: local.agent.list().map((agent) => agent.name),
      current: local.agent.current()?.name ?? "",
      loading: agentsQuery.isLoading,
      visible: settings.visibility.customAgents(),
      select: local.agent.set,
    },
    model: {
      selection: local.model,
      paid: bootstrap().status === "ready" && providers.paid().length > 0,
      loading: bootstrap().status !== "ready",
      bootstrap: bootstrap(),
    },
    session: {
      id: input.sessionID(),
      tabs: layout.tabs(input.sessionKey),
      reviewPanel: view.reviewPanel,
    },
    newLayoutDesigns: settings.general.newLayoutDesigns(),
  }))
}

export async function retryPromptBootstrap(input: {
  queryClient: QueryClient
  agents?: ReturnType<QueryOptionsApi["agents"]>
  providers?: ReturnType<QueryOptionsApi["providers"]>
  globalProviders?: ReturnType<QueryOptionsApi["providers"]>
  setAgents: (value: Agent[]) => void
}) {
  const pending: Promise<unknown>[] = []
  if (input.agents) {
    pending.push(input.queryClient.fetchQuery(input.agents).then((value) => input.setAgents(value)))
  }
  if (input.providers) pending.push(input.queryClient.fetchQuery(input.providers))
  if (input.globalProviders) pending.push(input.queryClient.fetchQuery(input.globalProviders))
  await Promise.allSettled(pending)
}

export function createPromptProjectControls() {
  const navigate = useNavigate()
  const layout = useLayout()
  const server = useServer()
  const serverSDK = useServerSDK()
  const sdk = useSDK()
  const tabs = useTabs()
  const global = useGlobal()
  const pickDirectory = useDirectoryPicker()
  const [search] = useSearchParams<{ draftId?: string }>()
  const projectServer = () => serverSDK().server
  const projectServerCtx = createMemo(() => global.ensureServerCtx(projectServer()))
  const projects = createMemo(() => {
    if (server.list.length <= 1) {
      return search.draftId ? projectServerCtx().projects.list() : layout.projects.list()
    }
    return server.list.flatMap((conn) => {
      const item = { key: ServerConnection.key(conn), name: serverName(conn) }
      return global
        .ensureServerCtx(conn)
        .projects.list()
        .map((project) => ({ ...project, server: item }))
    })
  })
  const selectProject = (worktree: string, serverKey?: string) => {
    const conn = serverKey ? server.list.find((conn) => ServerConnection.key(conn) === serverKey) : projectServer()
    if (search.draftId) {
      if (!conn) return
      const target = global.ensureServerCtx(conn)
      target.projects.open(worktree)
      target.projects.touch(worktree)
      tabs.updateDraft(search.draftId, { server: ServerConnection.key(conn), directory: worktree })
      return
    }

    if (!serverKey) {
      layout.projects.open(worktree)
      server.projects.touch(worktree)
      navigate(`/${base64Encode(worktree)}/session`)
      return
    }

    if (!conn) return
    const target = global.ensureServerCtx(conn)
    target.projects.open(worktree)
    target.projects.touch(worktree)
    server.setActive(ServerConnection.key(conn))
    navigate(`/${base64Encode(worktree)}/session`)
  }

  const addProject = (title: string, serverKey?: string) => {
    const conn = serverKey ? server.list.find((conn) => ServerConnection.key(conn) === serverKey) : projectServer()
    if (!conn) return
    pickDirectory({
      server: conn,
      title,
      onSelect: (result) => {
        const directory = Array.isArray(result) ? result[0] : result
        if (directory) selectProject(directory, serverKey)
      },
    })
  }

  return createMemo<PromptProjectControls>(() => ({
    available: projects(),
    directory: sdk().directory,
    server: server.list.length > 1 ? ServerConnection.key(projectServer()) : undefined,
    select: selectProject,
    add: addProject,
  }))
}
