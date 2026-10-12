<script lang="ts" module>
  export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'muted';
  /** default icon per tone (never colour alone: every pill has an icon and a text) */
  export const TONE_ICON: Record<Tone, string> = { ok: 'check', warn: 'clock', err: 'alert', info: 'info', muted: 'x' };
</script>

<script lang="ts">
  /** <StatusPill tone="warn" label={$t('admin.devices.waiting')} />  (icon defaults per tone; icon="" hides it only with a text) */
  export let tone: Tone = 'muted';
  export let label = '';
  export let icon: string | undefined = undefined;
  import Icon from '#lib/Icon.svelte';
  $: ic = icon ?? TONE_ICON[tone];
</script>

<span class="pill {tone}">{#if ic}<Icon name={ic} size={14} />{/if}<span>{label}<slot /></span></span>

<style>
  .pill { display: inline-flex; align-items: center; gap: .3rem; padding: .15rem .6rem .15rem .45rem; border-radius: 99px; font-size: .8rem; font-weight: 600; line-height: 1.4; white-space: nowrap; max-width: 100%; }
  .pill > span { overflow: hidden; text-overflow: ellipsis; }
  .ok { background: var(--tone-ok); color: var(--ok); }
  .warn { background: var(--tone-warn); color: var(--warn); }
  .err { background: var(--tone-err); color: var(--err); }
  .info { background: var(--tone-info); color: var(--info); }
  .muted { background: var(--tone-muted); color: var(--mut); }
</style>
