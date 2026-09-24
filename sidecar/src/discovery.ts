import { join } from 'node:path';

import type { CopilotClient } from '@github/copilot-sdk';

import { copilotHome } from './paths.js';
import type {
  AgentSummary,
  McpServerConfig,
  McpServerSummary,
  ModelChoice,
  ReasoningEffort,
  SessionEnvironment,
} from '../../shared/protocol.js';

/**
 * What a machine offers, as against what a conversation holds.
 *
 * Every answer here comes off the shared server rather than out of a session: the models
 * there are, the agents and skills a directory would load, the MCP servers it would be
 * offered. None of it reads `loaded`, none of it touches the idle timer, and none of it can
 * evict anything - which is why it sits apart from the runtime rather than inside it (#183).
 *
 * It borrows the runtime's client rather than starting its own. One server process for the
 * whole app is the premise the app is built on, and two would double the thing it exists to
 * avoid.
 */
export class Discovery {
  /**
   * Where the reader's plugins live, resolved once per client.
   *
   * Held here rather than in the runtime because it is a fact about the machine, not about
   * any session - even though the sessions are what need it.
   */
  private pluginDirs: string[] | null = null;

  /** How to reach the shared server, which the runtime owns and starts on demand. */
  constructor(private readonly connect: () => Promise<CopilotClient>) {}

  /**
   * Drop what was cached against the server that is going away.
   *
   * Called when the runtime stops its client. What is held here is true of a particular
   * server rather than of the machine for ever: the next one could be a different CLI, with
   * different plugins installed.
   */
  forget(): void {
    this.pluginDirs = null;
  }

  /**
   * The models this account may use.
   *
   * Listing them needs the shared server, so this is the one read that costs a process.
   * Asked for when a reader opens the picker rather than at startup, and answered from the
   * server's own cache after that.
   *
   * Trimmed here rather than in the UI: what the runtime reports carries context limits and
   * token pricing tables that nothing shows, and the protocol is better off narrow.
   */
  async models(): Promise<ModelChoice[]> {
    const client = await this.connect();

    return (await client.listModels()).map((model) => {
      const prices = model.billing?.tokenPrices;
      // Prices are quoted per billing batch, and a batch is not a million tokens for every
      // model, so they are converted here rather than left for the UI to get wrong.
      const perMillion = (value?: number) =>
        value === undefined ? undefined : value * (1_000_000 / (prices?.batchSize || 1_000_000));

      return {
        id: model.id,
        name: model.name,
        reasoningEfforts: (model.supportedReasoningEfforts ?? []) as ReasoningEffort[],
        defaultReasoningEffort: model.defaultReasoningEffort as ReasoningEffort | undefined,
        // The sizes a model runs at are described by what each is priced for, which is also
        // the only place the larger one is mentioned. Some models are priced without saying
        // how much they take, and for those the model's own prompt limit is the answer.
        contexts: [
          ...(prices?.maxPromptTokens || model.capabilities?.limits?.max_prompt_tokens
            ? [
                {
                  tier: 'default' as const,
                  maxPromptTokens: prices?.maxPromptTokens ?? model.capabilities.limits.max_prompt_tokens!,
                },
              ]
            : []),
          ...(prices?.longContext?.maxPromptTokens
            ? [{ tier: 'long_context' as const, maxPromptTokens: prices.longContext.maxPromptTokens }]
            : []),
        ],
        prices: prices && {
          input: perMillion(prices.inputPrice),
          cachedInput: perMillion(prices.cacheReadPrice ?? prices.cachePrice),
          output: perMillion(prices.outputPrice),
        },
        // Listed but unusable until its terms are accepted, which happens outside this app.
        needsAgreement: model.policy?.state === 'unconfigured',
      };
    });
  }

  /**
   * The custom agents there are.
   *
   * Asked of the server, which has its own sessionless `agents` namespace, rather than of a
   * session's `agent.list`. The difference is the whole design: listing through a session
   * would mean resuming one to find out what agents exist, and this app exists because
   * resuming is expensive.
   *
   * A working directory is passed on as a project path, so a session in a repository sees the
   * agents that repository carries as well as the reader's own. Without one only the reader's
   * own are found, which is the right answer for a session that is not about a project.
   *
   * Built-in agents are not returned. Including them is a parameter of the session surface
   * only, and a cold list that silently left some out would be worse than one that never
   * offered them in the first place.
   */
  async agents(cwd?: string): Promise<AgentSummary[]> {
    const client = await this.connect();
    const { agents } = await client.rpc.agents.discover(cwd ? { projectPaths: [cwd] } : {});

    return agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      displayName: agent.displayName,
      description: agent.description,
      source: agent.source ?? 'unknown',
      ...(agent.path ? { path: agent.path } : {}),
      ...(agent.model ? { model: agent.model } : {}),
      // Absent means invocable. The field marks the exceptions, which are agents meant only
      // to be spawned by other agents rather than chosen by a reader.
      userInvocable: agent.userInvocable !== false,
    }));
  }

  /**
   * What a session in this directory would load, without loading one.
   *
   * Every part comes off the server surface, so this answers for a session the app has
   * never opened, and for no session at all. The alternative is a session's own
   * `instructions.getSources`, which was measured to agree exactly and costs a resume to ask.
   *
   * Gathered together because the panel wants all of it at once, and a round trip per
   * section is a chance for it to render half-empty.
   */
  async environment(cwd?: string): Promise<SessionEnvironment> {
    const client = await this.connect();
    const projectPaths = cwd ? { projectPaths: [cwd] } : {};

    const [instructions, plugins, extensions, skills, mcpServers, agents, hooks] = await Promise.all([
      client.rpc.instructions.discover(projectPaths),
      client.rpc.plugins.list(),
      client.rpc.extensions.discover(),
      client.rpc.skills.discover(projectPaths),
      // Through the same reader the composer uses, so the panel and the completion cannot
      // come to describe the servers differently.
      this.mcpServers(cwd),
      // The same reader the agent picker uses, for the same reason.
      this.agents(cwd),
      client.rpc.hooks.discover(projectPaths),
    ]);

    return {
      instructions: (instructions.sources ?? []).map((source) => ({
        id: source.id,
        label: source.label,
        sourcePath: source.sourcePath,
        content: source.content,
        type: source.type,
        location: source.location,
      })),
      plugins: (plugins.plugins ?? []).map((plugin) => ({
        name: plugin.name,
        marketplace: plugin.marketplace,
        ...(plugin.version ? { version: plugin.version } : {}),
        enabled: plugin.enabled !== false,
      })),
      extensions: (extensions.extensions ?? []).map((extension) => ({
        id: extension.id,
        name: extension.name,
        path: extension.path,
        source: extension.source,
        enabled: extension.enabled !== false,
        ...(extension.plugin ? { plugin: extension.plugin.name } : {}),
      })),
      skills: (skills.skills ?? []).map((skill) => ({
        name: skill.name,
        ...(skill.commandName ? { commandName: skill.commandName } : {}),
        description: skill.description,
        source: skill.source,
        userInvocable: skill.userInvocable !== false,
        enabled: skill.enabled !== false,
        ...(skill.path ? { path: skill.path } : {}),
      })),
      skillErrors: skills.errors ?? [],
      mcpServers,
      agents,
      hooks: (hooks.hooks ?? []).map((hook) => ({
        id: hook.id,
        event: hook.hookType,
        origin: hook.origin,
        ...(hook.source ? { source: hook.source } : {}),
        enabled: hook.enabled !== false,
      })),
      // Warnings alongside errors: the runtime separates a source that loaded with a
      // complaint from one that did not load, and both mean a hook may not fire.
      hookErrors: [...(hooks.errors ?? []), ...(hooks.warnings ?? [])],
      extensionMode: extensions.mode,
    };
  }

  /**
   * The MCP servers a directory would be offered, on their own.
   *
   * Shares its discovery with the environment panel but is asked for separately, because
   * completing a server name should not fetch the instructions, plugins, extensions and
   * skills that the panel wants and a half-typed command does not.
   *
   * Costs no Copilot process, like the rest of discovery.
   */
  async mcpServers(cwd?: string): Promise<McpServerSummary[]> {
    const client = await this.connect();

    /**
     * Two readers, because they answer different questions.
     *
     * `discover` says what a directory would be offered and whether each is switched on,
     * including the servers a plugin brings. `config.list` says what is written in the
     * reader's own file, which is the only thing this app can change and the only place the
     * url or command is recorded (#24).
     */
    const [discovered, configured] = await Promise.all([
      client.rpc.mcp.discover(cwd ? { workingDirectory: cwd } : {}),
      // A config that cannot be read still leaves the list worth showing, just not editable.
      this.mcpConfig(),
    ]);

    return (discovered.servers ?? []).map((server) => {
      const own = configured[server.name];
      const command = typeof own?.command === 'string' ? own.command : undefined;
      const url = typeof own?.url === 'string' ? own.url : undefined;
      const args = Array.isArray(own?.args) ? own.args.filter((arg): arg is string => typeof arg === 'string') : undefined;

      return {
        name: server.name,
        ...(server.type ? { type: server.type } : {}),
        source: server.source,
        ...(server.sourcePlugin ? { sourcePlugin: server.sourcePlugin } : {}),
        enabled: server.enabled,
        ...(url ? { url } : {}),
        ...(command ? { command } : {}),
        ...(args?.length ? { args } : {}),
        // In the reader's own file, which is the file the config RPC writes. A plugin's
        // server is in the plugin's, and writing here would make a copy rather than a change.
        editable: own !== undefined && !server.sourcePlugin,
      };
    });
  }

  /**
   * What is written in the reader's own MCP config, by name.
   *
   * Nothing at all when it cannot be read, which leaves a list worth showing rather than no
   * list: the servers still run, they just cannot be edited from here.
   */
  private async mcpConfig(): Promise<Record<string, Record<string, unknown> | undefined>> {
    const client = await this.connect();
    try {
      const { servers } = await client.rpc.mcp.config.list();
      return (servers ?? {}) as unknown as Record<string, Record<string, unknown> | undefined>;
    } catch {
      return {};
    }
  }

  /**
   * Write a server into the reader's own config, or change one that is already there.
   *
   * Costs no session. The config is the reader's own file rather than anything a
   * conversation holds, which is what lets this be offered beside a list that also costs
   * nothing to read (#24).
   *
   * `add` and `update` are separate calls in the runtime and one here, because the
   * difference is not one a reader is aware of making: a form that was opened on an
   * existing server saves, and a form that was opened empty saves, and both mean "let this
   * be what the server is".
   */
  async saveMcpServer(name: string, config: McpServerConfig): Promise<void> {
    const client = await this.connect();
    const servers = await this.mcpConfig();
    // Kept, so saving a server does not silently drop the filters and timeouts this app
    // has no controls for. Only the fields below are this app's to overwrite.
    const existing = servers[name] ?? {};

    const written =
      config.transport === 'http'
        ? { ...existing, type: 'http', url: config.url, command: undefined, args: undefined }
        : { ...existing, type: 'local', command: config.command, args: config.args ?? [], url: undefined };

    if (servers[name]) await client.rpc.mcp.config.update({ name, config: written as never });
    else await client.rpc.mcp.config.add({ name, config: written as never });
  }

  /** Take a server out of the reader's own config. */
  async removeMcpServer(name: string): Promise<void> {
    const client = await this.connect();
    await client.rpc.mcp.config.remove({ name });
  }

  /**
   * Turn an MCP server on or off for sessions started from now on.
   *
   * Costs no session, on either side of the wire: the disabled list is the reader's own
   * configuration, and the runtime keeps it rather than any conversation. Sessions already
   * running keep the servers they connected to until they end, which is the runtime's own
   * behaviour and worth saying out loud wherever this is offered.
   *
   * Takes one name where the runtime takes a list. Nothing here has a reason to change
   * several at once, and a caller that did would have to decide what a partial failure
   * meant; one at a time either worked or did not.
   */
  async setMcpEnabled(name: string, enabled: boolean): Promise<void> {
    const client = await this.connect();

    if (enabled) await client.rpc.mcp.config.enable({ names: [name] });
    else await client.rpc.mcp.config.disable({ names: [name] });
  }

  /**
   * Where the reader's installed plugins live, for a session to load skills from.
   *
   * Plugin skills sit under `installed-plugins/<marketplace>/<plugin>/skills`, which is
   * not one of the places skills are discovered, so a session without this saw none of
   * them while the same session in a terminal saw all of them (#163). Plugin agents were
   * never affected, which is what kept it quiet.
   *
   * The list comes from the runtime's own record rather than a directory walk, so a
   * plugin the reader has disabled stays disabled. Resolved once per client: plugins are
   * installed far less often than sessions are opened.
   */
  async pluginDirectories(client: CopilotClient): Promise<string[]> {
    if (this.pluginDirs) return this.pluginDirs;

    try {
      const { plugins } = await client.rpc.plugins.list();
      this.pluginDirs = (plugins ?? [])
        .filter((plugin) => plugin.enabled !== false)
        .map((plugin) => join(copilotHome, 'installed-plugins', plugin.marketplace, plugin.name));
    } catch {
      // Worth a session without plugin skills, never worth no session at all.
      this.pluginDirs = [];
    }

    return this.pluginDirs;
  }
}
