<script lang="ts">
  import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { FitAddon } from "@xterm/addon-fit";
  import { Unicode11Addon } from "@xterm/addon-unicode11";
  import { Terminal } from "@xterm/xterm";
  import { onMount } from "svelte";

  import {
    openTerminal,
    resizeTerminal,
    restartTerminal,
    writeTerminal,
    type TerminalEvent,
  } from "$lib/desktop";
  import { terminalWriteQueue } from "$lib/terminal-state";

  let {
    workspaceId,
    active,
    focusNonce,
    restartNonce,
  }: {
    workspaceId: string;
    active: boolean;
    focusNonce: number;
    restartNonce: number;
  } = $props();

  let container: HTMLDivElement;
  let terminal: Terminal | undefined;
  let terminalId = $state<string | null>(null);
  let terminalStatus = $state<"opening" | "running" | "exited" | "error">("opening");
  let message = $state("Opening terminal…");
  let seenFocusNonce = 0;
  let seenRestartNonce = 0;

  function handleEvent(event: TerminalEvent) {
    if (event.type === "output") {
      terminal?.write(new Uint8Array(event.data));
      return;
    }
    if (event.type === "exit") {
      terminalStatus = "exited";
      message = event.signal ? `Exited (${event.signal})` : `Exited with status ${event.code}`;
      return;
    }
    terminalStatus = "error";
    message = event.message;
  }

  async function restart() {
    if (!terminalId) return;
    terminalStatus = "opening";
    message = "Restarting terminal…";
    terminal?.clear();
    try {
      await restartTerminal(terminalId);
      terminalStatus = "running";
      terminal?.focus();
    } catch (error) {
      terminalStatus = "error";
      message = String(error);
    }
  }

  $effect(() => {
    if (terminal && active && focusNonce !== seenFocusNonce) {
      seenFocusNonce = focusNonce;
      queueMicrotask(() => terminal?.focus());
    }
  });

  $effect(() => {
    if (terminal && restartNonce !== seenRestartNonce) {
      seenRestartNonce = restartNonce;
      void restart();
    }
  });

  onMount(() => {
    const fitAddon = new FitAddon();
    const unicodeAddon = new Unicode11Addon();
    terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 10_000,
      theme: {
        background: "#f8f8f8",
        foreground: "#000000",
        cursor: "#000000",
        selectionBackground: "#cfe5fa",
      },
    });

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(unicodeAddon);
    terminal.unicode.activeVersion = "11";
    terminal.open(container);
    fitAddon.fit();

    const descriptorPromise = openTerminal(
      workspaceId,
      terminal.cols,
      terminal.rows,
      handleEvent,
    );

    const send = terminalWriteQueue(async (bytes) => {
      const descriptor = await descriptorPromise;
      await writeTerminal(descriptor.terminalId, bytes);
    });
    const dataDisposable = terminal.onData(send);
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || !event.metaKey) return true;
      const key = event.key.toLowerCase();
      if (key === "c" && terminal?.hasSelection()) {
        void writeText(terminal.getSelection());
        return false;
      }
      if (key === "v") {
        void readText().then((text) => terminal?.paste(text));
        return false;
      }
      return true;
    });

    let lastCols = terminal.cols;
    let lastRows = terminal.rows;
    let frame = 0;
    let resizePending = Promise.resolve();
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (container.clientWidth === 0 || container.clientHeight === 0) return;
        const viewportY = terminal?.buffer.active.viewportY ?? 0;
        fitAddon.fit();
        terminal?.scrollToLine(viewportY);
        if (!terminalId || !terminal || (terminal.cols === lastCols && terminal.rows === lastRows)) {
          return;
        }
        lastCols = terminal.cols;
        lastRows = terminal.rows;
        resizePending = resizePending
          .then(() => resizeTerminal(terminalId!, lastCols, lastRows))
          .catch(() => undefined);
      });
    });
    observer.observe(container);

    void descriptorPromise
      .then((descriptor) => {
        terminalId = descriptor.terminalId;
        terminalStatus = "running";
        if (active) terminal?.focus();
      })
      .catch((error) => {
        terminalStatus = "error";
        message = String(error);
      });

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      dataDisposable.dispose();
      terminal?.dispose();
      terminal = undefined;
    };
  });
</script>

<div class="relative h-full min-h-0 bg-app">
  <div bind:this={container} class="h-full w-full px-2 py-1" aria-label="Terminal"></div>
  {#if terminalStatus !== "running"}
    <div class="absolute inset-x-0 bottom-0 flex items-center justify-between border-t border-line bg-app px-2 py-1 text-xs text-muted">
      <span class="truncate">{message}</span>
      {#if terminalStatus === "exited" || terminalStatus === "error"}
        <button type="button" class="shrink-0 rounded px-2 py-1 text-fg hover:bg-surface-hover" onclick={restart}>Restart</button>
      {/if}
    </div>
  {/if}
</div>
