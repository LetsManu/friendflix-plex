<!-- SPDX-FileCopyrightText: 2026 Manuel Weißböck -->
<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  /** Small own SVG icon set (stroke icons, 24x24). Decorative unless `label` is given. */
  export let name: string;
  export let size = 24;
  export let label = '';
  export let fill = false;
</script>

<svg width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke={fill ? 'none' : 'currentColor'} stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
  role={label ? 'img' : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : 'true'} focusable="false">
  {#if name === 'play'}<path d="M7 4.5v15a1 1 0 001.5.86l12-7.5a1 1 0 000-1.72l-12-7.5A1 1 0 007 4.5z" fill="currentColor" stroke="none" />
  {:else if name === 'plus'}<path d="M12 5v14M5 12h14" />
  {:else if name === 'check'}<path d="M5 13l4 4L19 7" />
  {:else if name === 'info'}<circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" />
  {:else if name === 'search'}<circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" />
  {:else if name === 'bell'}<path d="M6 8a6 6 0 1112 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 004 0" />
  {:else if name === 'chevron-left'}<path d="M15 5l-7 7 7 7" />
  {:else if name === 'chevron-right'}<path d="M9 5l7 7-7 7" />
  {:else if name === 'chevron-down'}<path d="M5 9l7 7 7-7" />
  {:else if name === 'arrow-left'}<path d="M19 12H5M12 19l-7-7 7-7" />
  {:else if name === 'shuffle'}<path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
  {:else if name === 'heart'}<path d="M12 21s-8-5.2-8-11a4.5 4.5 0 018-2.8A4.5 4.5 0 0120 10c0 5.8-8 11-8 11z" />
  {:else if name === 'x'}<path d="M6 6l12 12M18 6L6 18" />
  {:else if name === 'users'}<circle cx="9" cy="8" r="3" /><path d="M3 20c0-3 3-5 6-5s6 2 6 5M16 5a3 3 0 010 6M18 15c2 .5 3 2 3 5" />
  {:else if name === 'user'}<circle cx="12" cy="8" r="4" /><path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
  {:else if name === 'tv'}<rect x="3" y="6" width="18" height="12" rx="2" /><path d="M8 3l4 3 4-3M9 21h6" />
  {:else if name === 'stop'}<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" stroke="none" />
  {:else if name === 'monitor'}<path d="M3 5h18v11H3zM8 21h8M12 16v5" />
  {:else if name === 'log-out'}<path d="M9 21H5V3h4M16 17l5-5-5-5M21 12H9" />
  {:else if name === 'bar-chart'}<path d="M5 20V10M12 20V4M19 20v-7" />
  {:else if name === 'calendar'}<path d="M4 6h16v14H4zM4 10h16M8 3v4M16 3v4" />
  {:else if name === 'star'}<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3l-5.5 2.9 1-6.2L3 9.6l6.2-.9z" />
  {:else if name === 'shield'}<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />
  {:else if name === 'film'}<path d="M4 4h16v16H4zM8 4v16M16 4v16M4 9h4M16 9h4M4 15h4M16 15h4" />
  {:else if name === 'globe'}<circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.500 2.700 3.700 5.700 3.700 9s-1.200 6.300-3.700 9c-2.500-2.700-3.700-5.700-3.700-9S9.500 5.700 12 3z" />
  {:else if name === 'home'}<path d="M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10" />
  {:else if name === 'menu'}<path d="M4 7h16M4 12h16M4 17h16" />
  {:else if name === 'vote'}<path d="M4 8h16v12H4zM8 8V4h8v4M9 13l2 2 4-4" />
  {:else if name === 'gift'}<path d="M4 9h16v4H4zM6 13v7h12v-7M12 9v11M12 9S9 9 9 6.500 12 5 12 9zM12 9s3 0 3-2.500S12 5 12 9z" />
  {:else if name === 'volume'}<path d="M11 5 6 9H3v6h3l5 4zM15.500 8.500a5 5 0 010 7M18.500 5.500a9 9 0 010 13" />
  {:else if name === 'volume-off'}<path d="M11 5 6 9H3v6h3l5 4zM22 9l-6 6M16 9l6 6" />
  {:else if name === 'pause'}<path d="M8 4.500h-1.500a1 1 0 00-1 1v13a1 1 0 001 1H8a1 1 0 001-1v-13a1 1 0 00-1-1zM17.500 4.500H16a1 1 0 00-1 1v13a1 1 0 001 1h1.500a1 1 0 001-1v-13a1 1 0 00-1-1z" fill="currentColor" stroke="none" />
  {:else if name === 'rewind10'}<path d="M3.500 12a8.500 8.500 0 102.600-6.100M3.500 4v4.500H8" /><path d="M9.500 15.500v-5l-1.300 1M13 10.500a1.400 2.500 0 011.400 2.500 1.400 2.500 0 01-1.400 2.500 1.400 2.500 0 01-1.400-2.500 1.400 2.500 0 011.400-2.500z" stroke-width="1.600" />
  {:else if name === 'forward10'}<path d="M20.500 12a8.500 8.500 0 11-2.600-6.100M20.500 4v4.500H16" /><path d="M9.500 15.500v-5l-1.300 1M13 10.500a1.400 2.500 0 011.400 2.500 1.400 2.500 0 01-1.400 2.500 1.400 2.500 0 01-1.400-2.500 1.400 2.500 0 011.400-2.500z" stroke-width="1.600" />
  {:else if name === 'volume'}<path d="M4 9.500v5h3.500L12 18.500v-13L7.500 9.500zM15.500 9a4 4 0 010 6M18 6.500a8 8 0 010 11" />
  {:else if name === 'volume-low'}<path d="M4 9.500v5h3.500L12 18.500v-13L7.500 9.500zM15.500 9a4 4 0 010 6" />
  {:else if name === 'volume-off'}<path d="M4 9.500v5h3.500L12 18.500v-13L7.500 9.500zM16 9.500l5 5M21 9.500l-5 5" />
  {:else if name === 'subtitles'}<path d="M3 5h18v14H3zM7 11h3M13 11h4M7 15h5M15 15h2" />
  {:else if name === 'fullscreen'}<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  {:else if name === 'fullscreen-exit'}<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
  {:else if name === 'gauge'}<path d="M4 17a8 8 0 1116 0M12 13l4-4" /><circle cx="12" cy="13" r="1" />
  {:else if name === 'message'}<path d="M4 5h16v11H9l-5 4z" />
  {:else if name === 'smile'}<circle cx="12" cy="12" r="9" /><path d="M8 14c1 1.500 2.300 2 4 2s3-.5 4-2M9 9.500h.01M15 9.500h.01" />
  {:else if name === 'link'}<path d="M10 14a4 4 0 005.600 0l3-3a4 4 0 00-5.600-5.600l-1 1M14 10a4 4 0 00-5.600 0l-3 3a4 4 0 005.600 5.600l1-1" />
  {:else if name === 'lock'}<path d="M5 11h14v10H5zM8 11V7a4 4 0 018 0v4" />
  {:else if name === 'skip-next'}<path d="M6 5l10 7-10 7zM19 5v14" />
  {:else if name === 'crown'}<path d="M3 8l4.500 4L12 5l4.500 7L21 8l-2 11H5z" />
  {:else if name === 'settings'}<circle cx="12" cy="12" r="3" /><path d="M19.400 15a1.700 1.700 0 00.340 1.870l.06.06a2 2 0 11-2.830 2.830l-.06-.06a1.700 1.700 0 00-1.870-.340 1.700 1.700 0 00-1 1.550V21a2 2 0 11-4 0v-.090A1.700 1.700 0 008.900 19.400a1.700 1.700 0 00-1.870.340l-.06.06a2 2 0 11-2.830-2.830l.06-.06a1.700 1.700 0 00.340-1.870 1.700 1.700 0 00-1.550-1H3a2 2 0 110-4h.090A1.700 1.700 0 004.600 8.900a1.700 1.700 0 00-.340-1.870l-.06-.06a2 2 0 112.830-2.830l.06.06a1.700 1.700 0 001.870.340H9a1.700 1.700 0 001-1.550V3a2 2 0 114 0v.090a1.700 1.700 0 001 1.550 1.700 1.700 0 001.870-.340l.06-.06a2 2 0 112.830 2.830l-.06.06a1.700 1.700 0 00-.340 1.870V9a1.700 1.700 0 001.550 1H21a2 2 0 110 4h-.090a1.700 1.700 0 00-1.550 1z" />
  {:else if name === 'pip'}<path d="M3 5h18v14H3zM12 12h7v5h-7z" />
  {:else if name === 'bookmark'}<path d="M6 3h12v18l-6-4.500L6 21z" />
  {:else if name === 'share'}<circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><path d="M8.600 13.500l6.800 4M15.400 6.500l-6.800 4" />
  {:else if name === 'thumb-up'}<path d="M7 11v9H3v-9zM7 11l4-8a2 2 0 012 2v4h6a2 2 0 012 2.300l-1.300 7A2 2 0 0117.700 20H7" />
  {:else if name === 'thumb-down'}<path d="M7 13V4H3v9zM7 13l4 8a2 2 0 002-2v-4h6a2 2 0 002-2.300l-1.300-7A2 2 0 0017.700 4H7" />
  {:else if name === 'send'}<path d="M21 3L3 10.500l7 3L13 21zM10 13.500L21 3" />
  {:else if name === 'download'}<path d="M12 3v12M7 10l5 5 5-5M4 21h16" />
  {:else if name === 'list'}<path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01" />
  {:else if name === 'airplay'}<path d="M6 17H4a2 2 0 01-2-2V5a2 2 0 012-2h16a2 2 0 012 2v10a2 2 0 01-2 2h-2" /><path d="M12 14l5 7H7z" />
  {:else if name === 'cast'}<path d="M2 8V6a2 2 0 012-2h16a2 2 0 012 2v12a2 2 0 01-2 2h-6M2 12a9 9 0 019 9M2 16a5 5 0 015 5M2 20h.01" />
  {:else if name === 'copy'}<path d="M9 9h11v11H9zM5 15V4h11" />
  {:else if name === 'sun'}<circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
  {:else if name === 'unlock'}<path d="M5 11h14v10H5zM8 11V7a4 4 0 017.5-2" />
  {:else if name === 'keyboard'}<path d="M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M7 14h10" />
  {:else if name === 'grid'}<rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
  {:else if name === 'inbox'}<path d="M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v6H3v-6z" />
  {:else if name === 'activity'}<path d="M3 12h4l3-8 4 16 3-8h4" />
  {:else if name === 'refresh'}<path d="M20 11a8 8 0 00-14.6-4.5L3 9M3 4v5h5M4 13a8 8 0 0014.6 4.5L21 15M21 20v-5h-5" />
  {:else if name === 'mail'}<rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" />
  {:else if name === 'image'}<rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="M21 16l-5-5-9 9" />
  {:else if name === 'alert'}<path d="M12 3l10 18H2zM12 10v4M12 17.5h.01" />
  {:else if name === 'hard-drive'}<path d="M3 13h18v6H3zM5.5 5h13L21 13H3zM7 16h.01M11 16h.01" />
  {:else if name === 'key'}<circle cx="8" cy="15" r="4" /><path d="M11 12l9-9M17 6l3 3M14 9l2 2" />
  {:else if name === 'arrow-up'}<path d="M12 19V5M5 12l7-7 7 7" />
  {:else if name === 'arrow-down'}<path d="M12 5v14M5 12l7 7 7-7" />
  {:else if name === 'sort'}<path d="M8 4v16M4 8l4-4 4 4M16 20V4M12 16l4 4 4-4" />
  {:else if name === 'qr'}<path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3" />
  {:else if name === 'clock'}<circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
  {/if}
</svg>

<style>svg { display: block; flex: none; }</style>
