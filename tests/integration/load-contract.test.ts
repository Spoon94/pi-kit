import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import vigilTodo from "../../extensions/vigil-todo.js";

type Handler = (event: any, ctx: any) => unknown;

function makeContractPi() {
  const state = { initialized: false };
  const actionCalls: string[] = [];
  const registered = {
    tools: [] as string[],
    commands: [] as string[],
    shortcuts: [] as string[],
    handlers: new Map<string, Handler[]>(),
  };

  const guarded = (name: string, impl: (...args: any[]) => unknown) => (...args: any[]) => {
    actionCalls.push(name);
    if (!state.initialized) throw new Error("Extension runtime not initialized");
    return impl(...args);
  };

  const base: Record<string, unknown> = {
    on: (event: string, handler: Handler) => {
      const list = registered.handlers.get(event) ?? [];
      list.push(handler);
      registered.handlers.set(event, list);
      return () => {};
    },
    registerTool: (def: { name: string }) => { registered.tools.push(def.name); },
    registerCommand: (name: string) => { registered.commands.push(name); },
    registerShortcut: (key: string) => { registered.shortcuts.push(key); },
    registerFlag: () => {},
    getAllTools: guarded("getAllTools", () => [{ name: "todo", sourceInfo: { source: "pi-kit" } }]),
    getSettings: guarded("getSettings", () => ({})),
    getActiveTools: guarded("getActiveTools", () => []),
    setActiveTools: guarded("setActiveTools", () => {}),
    sendMessage: guarded("sendMessage", () => Promise.resolve()),
    sendUserMessage: guarded("sendUserMessage", () => {}),
    appendEntry: guarded("appendEntry", () => {}),
    getFlag: guarded("getFlag", () => undefined),
    getCommands: guarded("getCommands", () => []),
    exec: guarded("exec", () => Promise.resolve({})),
    refreshTools: guarded("refreshTools", () => {}),
  };

  // Any unknown method throws: the contract test must catch newly introduced host API usage
  const api = new Proxy(base, {
    get(target, prop) {
      if (typeof prop !== "string" || prop === "then") return (target as any)[prop];
      if (!(prop in target)) throw new Error(`unexpected pi API: ${prop}`);
      return (target as any)[prop];
    },
  });

  const ctx = {
    cwd: "",
    hasUI: false,
    mode: "text",
    ui: { notify: () => {}, setWidget: () => {} },
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => "S",
      getCwd: () => "",
      getBranch: () => [],
      getSessionDir: () => "",
    },
  };

  const emit = async (event: string, payload: any = { type: event }): Promise<void> => {
    for (const handler of registered.handlers.get(event) ?? []) await handler(payload, ctx);
  };

  return { api, ctx, state, actionCalls, registered, emit };
}

let oldConfigHome: string | undefined;

afterEach(() => {
  if (oldConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = oldConfigHome;
});

it("Factory body calls only registration APIs at load time; action APIs must wait for session_start (BLOCKER)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "vigil-load-"));
  const home = mkdtempSync(join(tmpdir(), "vigil-load-cfg-"));
  mkdirSync(join(home, "pi-kit"), { recursive: true });
  writeFileSync(join(home, "pi-kit", "config.json"), "{}");
  oldConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = home;

  const h = makeContractPi();
  h.ctx.cwd = cwd;
  h.ctx.sessionManager.getCwd = () => cwd;
  h.ctx.sessionManager.getSessionDir = () => join(cwd, ".sessions");

  // Load time: initialized=false, so any action call throws
  expect(() => vigilTodo(h.api as never)).not.toThrow();
  expect(h.actionCalls).toEqual([]);
  expect(h.registered.tools).toEqual(["todo", "bg_run", "bg_list", "bg_kill"]);
  expect(h.registered.commands).toEqual(["vigil-todo", "vt", "todos", "bg"]);
  expect(h.registered.shortcuts).toEqual([]);            // shortcuts deferred to session_start
  expect(h.registered.handlers.has("session_start")).toBe(true);

  // After runtime initialization, session_start can use action APIs
  h.state.initialized = true;
  await h.emit("session_start", { type: "session_start", reason: "startup" });
  expect(h.actionCalls).toContain("getAllTools");
  expect(h.actionCalls).toContain("getSettings");
  expect(h.registered.shortcuts).toHaveLength(2);        // collapse + one-tap halt
});
