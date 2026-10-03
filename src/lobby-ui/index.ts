/**
 * Drop-in lobby UI in plain DOM: no framework, works with any renderer
 * (WebGPU, WebGL, Canvas2D, DOM) and alongside React/Preact/Svelte/etc.
 *
 *   import { mountLobby, mountStatus } from 'lobbyhop/lobby-ui';
 *   mountLobby(room, { title: 'Siegeline', settings: [{ key: 'bots', label: 'Fill empty seats with bots', type: 'toggle' }] });
 *   mountStatus(room);
 *
 * Theme with CSS variables on :root or any ancestor: --lh-bg, --lh-fg,
 * --lh-dim, --lh-accent, --lh-accent-fg, --lh-border, --lh-radius, --lh-font, --lh-blur.
 */
import type { AnyGame, SettingsOf } from '../shared/game.js';
import type { RoomClient } from '../client/session.js';
import { shareLink } from '../client/profile.js';

export type SettingField =
  | { key: string; label: string; type: 'toggle'; hint?: string }
  | { key: string; label: string; type: 'number'; min?: number; max?: number; step?: number; hint?: string }
  | { key: string; label: string; type: 'select'; options: { value: string | number; label: string }[]; hint?: string };

export interface LobbyLabels {
  connecting: string;
  reconnecting: string;
  share: string;
  copy: string;
  copied: string;
  name: string;
  colour: string;
  players: string;
  openSeat: string;
  host: string;
  away: string;
  you: string;
  start: string;
  waiting: string;
  needPlayers: (min: number) => string;
  leave: string;
  spectating: string;
  gameOver: string;
  rematch: string;
  toLobby: string;
  chat: string;
  kick: string;
  /** Button for a player who isn't ready yet. */
  ready: string;
  /** Button for a player who is ready (click to undo). */
  readyOn: string;
  /** Chip on a ready player's seat. */
  readyChip: string;
  readyCount: (ready: number, total: number) => string;
  notReadyConfirm: (names: string[]) => string;
  startAnyway: string;
  cancel: string;
}

export interface LobbyOptions<G extends AnyGame = AnyGame> {
  /** Where to mount (default document.body). The panel is a fixed, centred overlay. */
  container?: HTMLElement;
  title?: string;
  /** A line under the title (e.g. how to play). */
  subtitle?: string;
  /** Host-editable settings, matching keys in your game's `settings.defaults`. */
  settings?: SettingField[];
  /** Label for empty seats (e.g. 'Bot' when your game fills them). A function can read settings. */
  emptySeat?: string | ((settings: SettingsOf<G>) => string);
  /** Show the colour picker (default true). */
  colours?: boolean;
  /** Show chat (default true). */
  chat?: boolean;
  /**
   * Show ready-up (default true): players toggle "I'm ready", seats show who is,
   * and the host gets a "start anyway?" confirmation if anyone isn't. It never
   * blocks the host.
   */
  ready?: boolean;
  /** Show the panel when the game is over, with rematch / back-to-lobby (default true). */
  showOver?: boolean;
  /** Where the game-over panel sits: 'bottom' (default; keeps the final board visible) or 'center'. */
  overPlacement?: 'bottom' | 'center';
  /** Extra content for the game-over panel (e.g. the winner). */
  overText?: (room: RoomClient<G>) => string;
  /** What "Leave" does (default: drop the room from the URL and reload). */
  onLeave?: () => void;
  /** URL query parameter holding the room code (default 'room'). */
  param?: string;
  /** The room code, for the share link (default: read from the URL). */
  code?: string;
  labels?: Partial<LobbyLabels>;
}

const LABELS: LobbyLabels = {
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  share: 'Share this link to invite players',
  copy: 'Copy',
  copied: 'Copied',
  name: 'Your name',
  colour: 'Your colour',
  players: 'Players',
  openSeat: 'Open seat',
  host: 'host',
  away: 'away',
  you: 'you',
  start: 'Start',
  waiting: 'Waiting for the host to start…',
  needPlayers: (n) => `Need ${n} players`,
  leave: 'Leave',
  spectating: 'The room is full or the game has started, so you are watching.',
  gameOver: 'Game over',
  rematch: 'Play again',
  toLobby: 'Back to lobby',
  chat: 'Say something…',
  kick: 'Remove',
  ready: "I'm ready",
  readyOn: 'Ready ✓',
  readyChip: 'ready',
  readyCount: (n, total) => `${n}/${total} ready`,
  notReadyConfirm: (names) => `Not everyone is ready (${names.join(', ')}). Start anyway?`,
  startAnyway: 'Start anyway',
  cancel: 'Cancel',
};

const CSS = `
.lh-overlay{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;z-index:1000;pointer-events:none;font-family:var(--lh-font,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif)}
.lh-panel{pointer-events:auto;box-sizing:border-box;width:min(440px,100%);max-height:calc(100vh - 32px);overflow:auto;padding:20px;border-radius:var(--lh-radius,16px);background:var(--lh-bg,rgba(20,22,30,.62));color:var(--lh-fg,#f3f4f8);border:1px solid var(--lh-border,rgba(255,255,255,.14));box-shadow:0 20px 60px rgba(0,0,0,.35);backdrop-filter:blur(var(--lh-blur,18px)) saturate(140%);-webkit-backdrop-filter:blur(var(--lh-blur,18px)) saturate(140%);display:flex;flex-direction:column;gap:14px;font-size:14px;line-height:1.4}
.lh-panel *{box-sizing:border-box}
.lh-panel h2{margin:0;font-size:20px;font-weight:600;letter-spacing:-.01em}
.lh-dim{color:var(--lh-dim,rgba(243,244,248,.62));font-size:13px}
.lh-bad{color:#ff8f8f}
.lh-row{display:flex;gap:8px;align-items:center}
.lh-field{display:flex;flex-direction:column;gap:6px}
.lh-panel input[type=text],.lh-panel input[type=number],.lh-panel select{flex:1;min-width:0;font:inherit;color:inherit;background:rgba(255,255,255,.08);border:1px solid var(--lh-border,rgba(255,255,255,.14));border-radius:10px;padding:8px 10px;outline:none}
.lh-panel input:focus,.lh-panel select:focus{border-color:var(--lh-accent,#7c9cff)}
.lh-panel button{font:inherit;color:inherit;background:rgba(255,255,255,.1);border:1px solid var(--lh-border,rgba(255,255,255,.14));border-radius:10px;padding:8px 14px;cursor:pointer;white-space:nowrap}
.lh-panel button:hover:not(:disabled){background:rgba(255,255,255,.16)}
.lh-panel button:disabled{opacity:.45;cursor:default}
.lh-panel button.lh-primary{background:var(--lh-accent,#7c9cff);color:var(--lh-accent-fg,#0b0d14);border-color:transparent;font-weight:600}
.lh-panel button.lh-primary:hover:not(:disabled){background:var(--lh-accent,#7c9cff);filter:brightness(1.1)}
.lh-swatches{display:flex;flex-wrap:wrap;gap:8px}
.lh-swatch{width:26px;height:26px;padding:0!important;border-radius:50%!important;border:2px solid transparent!important}
.lh-swatch.lh-on{border-color:var(--lh-fg,#fff)!important;box-shadow:0 0 0 2px rgba(0,0,0,.4) inset}
.lh-swatch:disabled{opacity:.2!important}
.lh-seats{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:6px}
.lh-seat{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:10px;background:rgba(255,255,255,.06);min-width:0}
.lh-seat.lh-empty{opacity:.5}
.lh-seat.lh-me{outline:1px solid var(--lh-accent,#7c9cff)}
.lh-seat .lh-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lh-dot{width:12px;height:12px;border-radius:50%;flex:none;background:rgba(255,255,255,.2)}
.lh-chip{font-size:11px;padding:1px 6px;border-radius:99px;background:rgba(255,255,255,.12);color:var(--lh-dim,rgba(243,244,248,.7))}
.lh-chip.lh-ready{background:var(--lh-ready-bg,rgba(48,164,108,.28));color:var(--lh-ready,#7ee2a8)}
.lh-panel button.lh-ready-on,.lh-panel button.lh-ready-on:hover:not(:disabled){background:var(--lh-ready-bg,rgba(48,164,108,.28));border-color:var(--lh-ready,#7ee2a8);color:var(--lh-ready,#7ee2a8)}
.lh-confirm{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:12px;background:rgba(255,210,122,.1);border:1px solid rgba(255,210,122,.35)}
.lh-confirm p{margin:0}
.lh-x{padding:0 6px!important;border:none!important;background:none!important;opacity:.5}
.lh-x:hover{opacity:1}
.lh-toggle{display:flex;gap:8px;align-items:center;cursor:pointer}
.lh-toggle input{accent-color:var(--lh-accent,#7c9cff);width:16px;height:16px}
.lh-actions{display:flex;gap:8px;justify-content:space-between;align-items:center;flex-wrap:wrap}
.lh-chat{display:flex;flex-direction:column;gap:6px}
.lh-lines{max-height:120px;overflow:auto;display:flex;flex-direction:column;gap:2px;font-size:13px}
.lh-lines b{font-weight:600}
.lh-status{position:fixed;top:12px;right:12px;z-index:999;display:flex;gap:8px;align-items:center;padding:6px 12px;border-radius:99px;font:12px/1.3 var(--lh-font,ui-sans-serif,system-ui,sans-serif);background:var(--lh-bg,rgba(20,22,30,.62));color:var(--lh-fg,#f3f4f8);border:1px solid var(--lh-border,rgba(255,255,255,.14));backdrop-filter:blur(var(--lh-blur,18px));-webkit-backdrop-filter:blur(var(--lh-blur,18px))}
.lh-status button{font:inherit;color:inherit;background:rgba(255,255,255,.1);border:1px solid var(--lh-border,rgba(255,255,255,.14));border-radius:99px;padding:2px 10px;cursor:pointer}
@media (max-width:480px){.lh-panel{padding:16px;gap:10px}.lh-seats{grid-template-columns:1fr 1fr}.lh-seat{padding:6px 8px}.lh-swatch{width:24px;height:24px}}
.lh-status .lh-good{color:#7ee2a8}.lh-status .lh-warn{color:#ffd27a}.lh-status .lh-bad{color:#ff8f8f}
`;

function injectStyle() {
  if (typeof document === 'undefined' || document.getElementById('lobbyhop-style')) return;
  const s = document.createElement('style');
  s.id = 'lobbyhop-style';
  s.textContent = CSS;
  document.head.appendChild(s);
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k === 'style') e.setAttribute('style', String(v));
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v as EventListener);
    else if (k in e) (e as unknown as Record<string, unknown>)[k] = v;
    else e.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) e.append(c);
  return e;
}

export interface Mounted {
  readonly el: HTMLElement;
  destroy(): void;
}

/** Mounts the lobby overlay. It shows itself in the lobby (and at game over) and hides during play. */
export function mountLobby<G extends AnyGame>(room: RoomClient<G>, opts: LobbyOptions<G> = {}): Mounted {
  injectStyle();
  const L = { ...LABELS, ...opts.labels };
  const param = opts.param ?? 'room';
  const code = opts.code ?? new URLSearchParams(location.search).get(param) ?? '';
  const link = shareLink(code, param);
  const showColours = opts.colours !== false;
  const showChat = opts.chat !== false;
  const showReady = opts.ready !== false;
  /** The host clicked Start while someone wasn't ready: ask before starting. */
  let confirming = false;

  const overlay = el('div', { class: 'lh-overlay' });
  const panel = el('div', { class: 'lh-panel', role: 'dialog', 'aria-label': opts.title ?? 'Lobby' });
  overlay.append(panel);
  (opts.container ?? document.body).append(overlay);

  // Persistent inputs (never re-created, so typing and focus survive updates).
  const nameInput = el('input', { type: 'text', maxLength: 20, value: room.profile.name, 'aria-label': L.name });
  const commitName = () => {
    const v = nameInput.value.trim();
    if (v && v !== room.me?.name) room.setProfile({ name: v });
  };
  nameInput.addEventListener('blur', commitName);
  nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && nameInput.blur());
  const chatInput = el('input', { type: 'text', maxLength: 280, placeholder: L.chat, 'aria-label': L.chat });
  chatInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !chatInput.value.trim()) return;
    room.say(chatInput.value);
    chatInput.value = '';
  });
  let copied = false;
  const copyBtn = el('button', {
    onclick: async () => {
      try {
        if (navigator.share && matchMedia('(pointer: coarse)').matches) await navigator.share({ url: link, title: opts.title });
        else await navigator.clipboard.writeText(link);
        copied = true;
        render();
        setTimeout(() => {
          copied = false;
          render();
        }, 1500);
      } catch {
        // Clipboard can be blocked; the link is selectable anyway.
      }
    },
  });
  const linkInput = el('input', { type: 'text', readOnly: true, value: link, onfocus: (e: Event) => (e.target as HTMLInputElement).select() });
  const lines = el('div', { class: 'lh-lines' });

  const leave = () => {
    if (opts.onLeave) return opts.onLeave();
    const url = new URL(location.href);
    url.searchParams.delete(param);
    location.href = url.toString();
  };

  const settingControl = (f: SettingField) => {
    const settings = room.settings as Record<string, unknown>;
    const v = settings[f.key];
    const disabled = !room.host;
    const set = (value: unknown) => room.setSettings({ [f.key]: value } as never);
    let control: HTMLElement;
    if (f.type === 'toggle') {
      control = el(
        'label',
        { class: 'lh-toggle', title: disabled ? 'The host decides' : f.hint },
        el('input', { type: 'checkbox', checked: !!v, disabled, onchange: (e: Event) => set((e.target as HTMLInputElement).checked) }),
        el('span', {}, f.label),
      );
    } else if (f.type === 'number') {
      control = el(
        'label',
        { class: 'lh-row', title: f.hint },
        el('span', { style: 'flex:1' }, f.label),
        el('input', { type: 'number', value: String(v ?? ''), min: f.min, max: f.max, step: f.step, disabled, style: 'flex:0 0 90px', onchange: (e: Event) => set(Number((e.target as HTMLInputElement).value)) }),
      );
    } else {
      const sel = el('select', { disabled, style: 'flex:0 0 auto', onchange: (e: Event) => set(f.options[(e.target as HTMLSelectElement).selectedIndex].value) });
      for (const o of f.options) sel.append(el('option', { value: String(o.value), selected: o.value === v }, o.label));
      control = el('label', { class: 'lh-row', title: f.hint }, el('span', { style: 'flex:1' }, f.label), sel);
    }
    return control;
  };

  // Ready-up: players toggle it; the host starts, after a confirmation if anyone isn't ready.
  const readyButton = () =>
    el(
      'button',
      { class: room.ready ? 'lh-ready-on' : '', 'aria-pressed': String(room.ready), onclick: () => room.setReady(!room.ready) },
      room.ready ? L.readyOn : L.ready,
    );
  const tryStart = () => {
    if (showReady && !room.allReady) {
      confirming = true;
      render();
    } else room.start();
  };
  const confirmBox = () =>
    el(
      'div',
      { class: 'lh-confirm', role: 'alertdialog' },
      el('p', {}, L.notReadyConfirm(room.notReady.map((m) => m.name))),
      el(
        'div',
        { class: 'lh-row' },
        el('button', { class: 'lh-primary', onclick: () => ((confirming = false), room.start()) }, L.startAnyway),
        el('button', { onclick: () => ((confirming = false), render()) }, L.cancel),
      ),
    );
  const readyCount = () => {
    const others = room.members.filter((m) => m.connected && !m.host);
    return showReady && others.length ? ` · ${L.readyCount(others.filter((m) => m.ready).length, others.length)}` : '';
  };

  const render = () => {
    const over = room.phase === 'over';
    const visible = room.error !== null || room.phase === 'lobby' || (over && opts.showOver !== false);
    overlay.style.display = visible ? '' : 'none';
    if (!visible) return;
    // A confirmation is moot once everyone's ready, or once the room moves on.
    if (confirming && (!room.host || room.allReady || room.phase === 'playing')) confirming = false;
    overlay.style.alignItems = over && !room.error && opts.overPlacement !== 'center' ? 'flex-end' : '';
    const focused = document.activeElement;
    const keep = [nameInput, chatInput, linkInput].includes(focused as HTMLInputElement) ? (focused as HTMLInputElement) : null;
    panel.replaceChildren();

    panel.append(el('h2', {}, over ? L.gameOver : (opts.title ?? 'Lobby')));
    if (room.error) {
      panel.append(el('p', { class: 'lh-bad', style: 'margin:0' }, room.error.reason));
      panel.append(el('div', { class: 'lh-actions' }, el('span'), el('button', { onclick: leave }, L.leave)));
      return;
    }
    if (over) {
      const text = opts.overText?.(room);
      if (text) panel.append(el('p', { style: 'margin:0' }, text));
      if (confirming) {
        panel.append(confirmBox());
        return;
      }
      panel.append(
        el(
          'div',
          { class: 'lh-actions' },
          room.host
            ? el('div', { class: 'lh-row' }, el('button', { class: 'lh-primary', onclick: tryStart }, L.rematch + readyCount()), el('button', { onclick: () => room.toLobby() }, L.toLobby))
            : room.seat !== null && showReady
              ? el('div', { class: 'lh-row' }, readyButton(), el('span', { class: 'lh-dim' }, L.waiting))
              : el('span', { class: 'lh-dim' }, L.waiting),
          el('button', { onclick: leave }, L.leave),
        ),
      );
      return;
    }
    const status = room.status === 'open' ? (opts.subtitle ?? L.share) : room.status === 'connecting' ? L.connecting : L.reconnecting;
    panel.append(el('p', { class: 'lh-dim', style: 'margin:0' }, status));
    copyBtn.textContent = copied ? L.copied : L.copy;
    panel.append(el('div', { class: 'lh-row' }, linkInput, copyBtn));

    if (room.spectating) panel.append(el('p', { class: 'lh-dim', style: 'margin:0' }, L.spectating));
    else {
      if (document.activeElement !== nameInput && room.me) nameInput.value = room.me.name;
      panel.append(el('label', { class: 'lh-field' }, el('span', { class: 'lh-dim' }, L.name), nameInput));
      if (showColours) {
        const taken = new Set(room.members.filter((m) => m.seat !== room.seat).map((m) => m.colour));
        const sw = el('div', { class: 'lh-swatches' });
        for (const c of room.rules.palette) {
          sw.append(
            el('button', {
              class: `lh-swatch ${room.me?.colour === c ? 'lh-on' : ''}`,
              style: `background:${c}`,
              disabled: taken.has(c),
              title: taken.has(c) ? 'Taken' : c,
              'aria-label': c,
              onclick: () => room.setProfile({ colour: c }),
            }),
          );
        }
        panel.append(el('div', { class: 'lh-field' }, el('span', { class: 'lh-dim' }, L.colour), sw));
      }
    }

    const seats = el('div', { class: 'lh-seats' });
    const empty = typeof opts.emptySeat === 'function' ? opts.emptySeat(room.settings) : (opts.emptySeat ?? L.openSeat);
    for (let i = 0; i < room.rules.max; i++) {
      const m = room.members.find((x) => x.seat === i);
      seats.append(
        el(
          'div',
          { class: `lh-seat ${m ? '' : 'lh-empty'} ${m && m.seat === room.seat ? 'lh-me' : ''}` },
          el('i', { class: 'lh-dot', style: m ? `background:${m.colour}` : '' }),
          el('span', { class: 'lh-name' }, m ? m.name : empty),
          m?.seat === room.seat && el('span', { class: 'lh-chip' }, L.you),
          m?.host && el('span', { class: 'lh-chip' }, L.host),
          showReady && m && !m.host && m.ready && el('span', { class: 'lh-chip lh-ready' }, L.readyChip),
          m && !m.connected && el('span', { class: 'lh-chip' }, L.away),
          m && room.host && m.seat !== room.seat && el('button', { class: 'lh-x', title: L.kick, 'aria-label': `${L.kick} ${m.name}`, onclick: () => room.kick(m.seat) }, '✕'),
        ),
      );
    }
    panel.append(el('div', { class: 'lh-field' }, el('span', { class: 'lh-dim' }, `${L.players} · ${room.members.length}/${room.rules.max}${room.spectators ? ` · ${room.spectators} watching` : ''}`), seats));

    if (opts.settings?.length) {
      const box = el('div', { class: 'lh-field' });
      for (const f of opts.settings) box.append(settingControl(f));
      panel.append(box);
    }

    if (showChat) {
      lines.replaceChildren(...room.chat.slice(-30).map((l) => el('div', {}, el('b', { style: `color:${room.members.find((m) => m.seat === l.seat)?.colour ?? 'inherit'}` }, l.name), ' ', l.text)));
      panel.append(el('div', { class: 'lh-chat' }, room.chat.length ? lines : null, chatInput));
      lines.scrollTop = lines.scrollHeight;
    }

    const enough = room.members.length >= room.rules.min;
    if (confirming) panel.append(confirmBox());
    else
      panel.append(
        el(
          'div',
          { class: 'lh-actions' },
          room.host
            ? el('button', { class: 'lh-primary', disabled: !room.connected || !enough, onclick: tryStart }, enough ? L.start + readyCount() : L.needPlayers(room.rules.min))
            : room.spectating
              ? el('span')
              : showReady
                ? el('div', { class: 'lh-row' }, readyButton(), el('span', { class: 'lh-dim' }, L.waiting))
                : el('span', { class: 'lh-dim' }, L.waiting),
          el('button', { onclick: leave }, L.leave),
        ),
      );
    if (keep) keep.focus();
  };

  const offs = [room.on('change', render)];
  render();
  return {
    el: overlay,
    destroy() {
      offs.forEach((f) => f());
      overlay.remove();
    },
  };
}

export interface StatusOptions {
  container?: HTMLElement;
  /** Show a pause button to the host (default true while playing). */
  pause?: boolean;
  param?: string;
}

/** A small in-game chip: room code, connection, ping, pause (host). */
export function mountStatus<G extends AnyGame>(room: RoomClient<G>, opts: StatusOptions = {}): Mounted {
  injectStyle();
  const code = new URLSearchParams(location.search).get(opts.param ?? 'room') ?? '';
  const chip = el('div', { class: 'lh-status' });
  (opts.container ?? document.body).append(chip);
  const render = () => {
    chip.style.display = room.phase === 'playing' || room.status !== 'open' ? '' : 'none';
    const conn =
      room.status === 'open'
        ? el('span', { class: room.rtt !== null && room.rtt > 250 ? 'lh-warn' : 'lh-good' }, room.rtt === null ? '●' : `● ${room.rtt} ms`)
        : el('span', { class: room.status === 'closed' ? 'lh-bad' : 'lh-warn' }, room.status === 'closed' ? 'Disconnected' : 'Reconnecting…');
    const parts: (HTMLElement | false)[] = [
      el('span', {}, code ? `Room ${code}` : 'Room'),
      conn,
      room.spectating && el('span', { class: 'lh-warn' }, 'Watching'),
      room.paused && el('span', { class: 'lh-warn' }, 'Paused'),
      opts.pause !== false && room.host && room.phase === 'playing' && el('button', { onclick: () => room.setPaused(!room.paused) }, room.paused ? 'Resume' : 'Pause'),
    ];
    chip.replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
  };
  const offs = [room.on('change', render)];
  const timer = setInterval(render, 3000);
  render();
  return {
    el: chip,
    destroy() {
      offs.forEach((f) => f());
      clearInterval(timer);
      chip.remove();
    },
  };
}
