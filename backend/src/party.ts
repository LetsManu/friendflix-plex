import { z } from 'zod';

/** Allowed reactions (whitelist: nothing user-controlled gets rendered as markup). */
export const EMOJIS = ['😂', '😮', '❤️', '👍', '😢', '🔥'] as const;

/** Live reactions per member: a burst of 5, then one every 700 ms (token bucket). Excess reactions are dropped silently. */
export const REACT_BURST = 5;
export const REACT_REFILL_MS = 700;

export const clientMsg = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ping'), c: z.number() }),
  z.object({ t: z.literal('state'), playing: z.boolean(), position: z.number().min(0).max(1e6) }),
  z.object({ t: z.literal('buffering'), value: z.boolean() }),
  z.object({ t: z.literal('chat'), text: z.string().trim().min(1).max(500) }),
  z.object({ t: z.literal('react'), emoji: z.enum(EMOJIS) }),
  z.object({ t: z.literal('host'), to: z.string() }),
  z.object({ t: z.literal('mode'), value: z.enum(['host', 'everyone']) }),
]);
export type ClientMsg = z.infer<typeof clientMsg>;

export type ControlMode = 'host' | 'everyone';

export interface PartyState {
  playing: boolean;
  /** seconds at server time `at` */
  position: number;
  at: number;
  /** true while at least one member is buffering: everybody waits */
  hold: boolean;
}

export type ServerMsg =
  | { t: 'welcome'; you: string; hostId: string; mode: ControlMode; itemId: string; title: string; startAt?: number; members: MemberInfo[]; state: PartyState; serverNow: number }
  | { t: 'state'; state: PartyState; serverNow: number }
  | { t: 'members'; hostId: string; mode: ControlMode; members: MemberInfo[] }
  | { t: 'chat'; from: string; name: string; text: string; at: number }
  | { t: 'react'; from: string; name: string; emoji: string }
  | { t: 'pong'; c: number; s: number };

export interface MemberInfo {
  id: string;
  name: string;
  buffering: boolean;
}

export interface Member extends MemberInfo {
  send: (m: ServerMsg) => void;
  chatTimes: number[];
  /** reaction token bucket (see REACT_BURST) */
  reactTokens: number;
  reactAt: number;
}

export class Room {
  readonly members = new Map<string, Member>();
  state: PartyState;
  /** who may play/pause/seek: only the host, or everybody (like Amazon Watch Party's "everyone can control") */
  mode: ControlMode = 'host';
  started: boolean;
  emptySince?: number;

  constructor(
    readonly id: string,
    readonly itemId: string,
    readonly title: string,
    public hostId: string,
    readonly startAt: number | undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.state = { playing: false, position: 0, at: now(), hold: false };
    this.started = startAt === undefined;
  }

  positionNow(): number {
    const s = this.state;
    return s.playing && !s.hold ? s.position + (this.now() - s.at) / 1000 : s.position;
  }

  private info(): MemberInfo[] {
    return [...this.members.values()].map((m) => ({ id: m.id, name: m.name, buffering: m.buffering }));
  }

  private all(msg: ServerMsg) {
    for (const m of this.members.values()) m.send(msg);
  }

  private pushState() {
    this.all({ t: 'state', state: this.state, serverNow: this.now() });
  }

  /** Recomputes hold = anyone buffering. Freezes the position when the hold starts, restarts the clock when it ends. */
  private updateHold() {
    const hold = [...this.members.values()].some((m) => m.buffering);
    if (hold === this.state.hold) return;
    const t = this.now();
    this.state = { ...this.state, position: this.positionNow(), at: t, hold };
    this.pushState();
  }

  join(id: string, name: string, send: (m: ServerMsg) => void): Member {
    const existing = this.members.get(id);
    if (existing) existing.send = send; // reconnect (e.g. second tab replaces the first)
    const m: Member = existing ?? { id, name, buffering: true, send, chatTimes: [], reactTokens: REACT_BURST, reactAt: this.now() }; // a joiner buffers first -> room waits
    m.send = send;
    m.buffering = true;
    this.members.set(id, m);
    this.emptySince = undefined;
    send({ t: 'welcome', you: id, hostId: this.hostId, mode: this.mode, itemId: this.itemId, title: this.title, startAt: this.startAt, members: this.info(), state: this.state, serverNow: this.now() });
    this.all({ t: 'members', hostId: this.hostId, mode: this.mode, members: this.info() });
    this.updateHold();
    return m;
  }

  leave(id: string) {
    if (!this.members.delete(id)) return;
    if (this.hostId === id) this.hostId = this.members.keys().next().value ?? this.hostId;
    if (!this.members.size) this.emptySince = this.now();
    this.all({ t: 'members', hostId: this.hostId, mode: this.mode, members: this.info() });
    this.updateHold();
  }

  handle(id: string, msg: ClientMsg) {
    const m = this.members.get(id);
    if (!m) return;
    switch (msg.t) {
      case 'ping':
        m.send({ t: 'pong', c: msg.c, s: this.now() });
        break;
      case 'state':
        if (id !== this.hostId && this.mode !== 'everyone') return; // only the host (or everyone, if enabled) controls playback
        this.state = { playing: msg.playing, position: msg.position, at: this.now(), hold: this.state.hold };
        this.pushState();
        break;
      case 'buffering':
        m.buffering = msg.value;
        this.all({ t: 'members', hostId: this.hostId, mode: this.mode, members: this.info() });
        this.updateHold();
        break;
      case 'chat': {
        const t = this.now();
        m.chatTimes = m.chatTimes.filter((x) => t - x < 5000);
        if (m.chatTimes.length >= 5) return; // flood protection: 5 messages / 5 s
        m.chatTimes.push(t);
        this.all({ t: 'chat', from: id, name: m.name, text: msg.text, at: t });
        break;
      }
      case 'react': {
        const t = this.now();
        m.reactTokens = Math.min(REACT_BURST, m.reactTokens + (t - m.reactAt) / REACT_REFILL_MS);
        m.reactAt = t;
        if (m.reactTokens < 1) return; // flood protection: floating emojis are not persisted, so just drop the excess
        m.reactTokens -= 1;
        this.all({ t: 'react', from: id, name: m.name, emoji: msg.emoji });
        break;
      }
      case 'mode':
        if (id !== this.hostId) return;
        this.mode = msg.value;
        this.all({ t: 'members', hostId: this.hostId, mode: this.mode, members: this.info() });
        break;
      case 'host':
        if (id === this.hostId && this.members.has(msg.to)) {
          this.hostId = msg.to;
          this.all({ t: 'members', hostId: this.hostId, mode: this.mode, members: this.info() });
        }
        break;
    }
  }

  /** Called every second: auto-start for scheduled film nights. */
  tick() {
    if (!this.started && this.startAt !== undefined && this.now() >= this.startAt) {
      this.started = true;
      this.state = { playing: true, position: 0, at: this.now(), hold: this.state.hold };
      this.pushState();
    }
  }
}

export class PartyRegistry {
  readonly rooms = new Map<string, Room>();
  constructor(private readonly now: () => number = Date.now) {}

  create(opts: { id: string; itemId: string; title: string; hostId: string; startAt?: number }): Room {
    const r = new Room(opts.id, opts.itemId, opts.title, opts.hostId, opts.startAt, this.now);
    this.rooms.set(r.id, r);
    return r;
  }
  get(id: string) {
    return this.rooms.get(id);
  }
  tick() {
    for (const [id, r] of this.rooms) {
      r.tick();
      const t = this.now();
      // scheduled rooms (startAt up to 24h ahead) live until startAt + 6h, even when nobody is in them yet
      const scheduled = !r.started && r.startAt !== undefined && t < r.startAt + 6 * 3600_000;
      const idle = !scheduled && r.emptySince !== undefined && t - r.emptySince > 10 * 60_000;
      const neverJoined = !scheduled && !r.members.size && r.emptySince === undefined && t - Math.max(r.state.at, r.startAt ?? 0) > 6 * 3600_000;
      if (idle || neverJoined) this.rooms.delete(id);
    }
  }
}
