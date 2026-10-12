/** Typed fixtures for the mocked Friendflix API (shapes follow web/src/lib/api.ts and the backend DTOs). */

export interface MockItem {
  id: string;
  name: string;
  type: 'Movie' | 'Series' | 'Episode' | 'Season';
  year?: number;
  overview?: string;
  runtimeTicks?: number;
  genres: string[];
  rating?: string;
  communityRating?: number;
  premiereDate?: string;
  image: boolean;
  backdrop: boolean;
  logo: boolean;
  trailers?: number;
  played: boolean;
  favorite: boolean;
  positionTicks: number;
  playedPercentage?: number;
  seriesId?: string;
  seriesName?: string;
  seasonId?: string;
  parentIndexNumber?: number;
  indexNumber?: number;
  langs?: { audio: string[]; subs: string[] };
  viewers?: number;
  lastAdded?: string;
  unplayedCount?: number;
  childCount?: number;
}

/** 32-hex Jellyfin-style id. */
export const hex = (n: number): string => n.toString(16).padStart(32, '0');
/** uuid used for lists */
export const uuid = (n: number): string => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

type Row = [name: string, type: 'Movie' | 'Series', year: number, genres: string[], rating: number];
const ROWS: Row[] = [
  ['Inception', 'Movie', 2010, ['Sci-Fi', 'Action'], 8.8],
  ['Interstellar', 'Movie', 2014, ['Sci-Fi', 'Drama'], 8.7],
  ['The Dark Knight', 'Movie', 2008, ['Action', 'Krimi'], 9.0],
  ['Dunkirk', 'Movie', 2017, ['Drama', 'Krieg'], 7.8],
  ['Memento', 'Movie', 2000, ['Thriller', 'Mystery'], 8.4],
  ['Oppenheimer', 'Movie', 2023, ['Drama', 'Historie'], 8.3],
  ['Pulp Fiction', 'Movie', 1994, ['Krimi', 'Drama'], 8.9],
  ['Die Verurteilten', 'Movie', 1994, ['Drama'], 9.3],
  ['Breaking Bad', 'Series', 2008, ['Drama', 'Krimi'], 9.5],
  ['Dark', 'Series', 2017, ['Sci-Fi', 'Mystery'], 8.7],
  ['Stranger Things', 'Series', 2016, ['Sci-Fi', 'Horror'], 8.6],
  ['The Wire', 'Series', 2002, ['Krimi', 'Drama'], 9.3],
];

export const items: MockItem[] = ROWS.map(([name, type, year, genres, communityRating], i) => ({
  id: hex(i + 1),
  name,
  type,
  year,
  overview: `${name} ist ein packender Titel. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore.`,
  runtimeTicks: type === 'Movie' ? 88_800_000_000 : 0,
  genres,
  rating: 'FSK 12',
  communityRating,
  premiereDate: `${year}-05-01T00:00:00Z`,
  image: true,
  backdrop: true,
  logo: false,
  trailers: 0,
  played: false,
  favorite: i % 5 === 0,
  positionTicks: 0,
  langs: { audio: ['deu', 'eng'], subs: ['deu'] },
}));
export const byName = (name: string): MockItem => items.find((i) => i.name === name)!;
export const MOVIE = items[0]!; // Inception
export const MOVIE2 = items[1]!;
export const SERIES = items[8]!; // Breaking Bad

export const episodes: MockItem[] = Array.from({ length: 6 }, (_, i) => ({
  id: hex(100 + i),
  name: `Folge ${i + 1}`,
  type: 'Episode' as const,
  seriesId: SERIES.id,
  seriesName: SERIES.name,
  seasonId: hex(200),
  parentIndexNumber: 1,
  indexNumber: i + 1,
  genres: [],
  year: 2008,
  image: true,
  backdrop: true,
  logo: false,
  played: false,
  favorite: false,
  positionTicks: i === 0 ? 9_000_000_000 : 0,
  playedPercentage: i === 0 ? 42 : undefined,
  runtimeTicks: 27_000_000_000,
  overview: 'Episode overview.',
}));

export const people = [
  { id: hex(300), name: 'Christopher Nolan', role: '', type: 'Director', image: true },
  { id: hex(301), name: 'Leonardo DiCaprio', role: 'Cobb', type: 'Actor', image: true },
  { id: hex(302), name: 'Elliot Page', role: 'Ariadne', type: 'Actor', image: false },
  { id: hex(303), name: 'Tom Hardy', role: 'Eames', type: 'Actor', image: true },
  { id: hex(304), name: 'Hans Zimmer', role: '', type: 'Composer', image: true },
];

export const nolan = items.filter((i) => ['Inception', 'Interstellar', 'The Dark Knight', 'Dunkirk', 'Memento', 'Oppenheimer'].includes(i.name));

export const ME = {
  id: 'u1',
  name: 'Tester',
  role: 'user',
  roleLabel: 'Nutzer',
  isAdmin: false,
  csrfToken: 'x',
  deviceApproved: true,
  tv: false,
  profile: { id: 'p1', name: 'Tester', avatar: 'a1', isOwner: true },
  profileRequired: false,
  profileCount: 1,
  profileChosen: true,
  downloads: { allowed: false, max: 0 },
};

export interface MockList {
  /** Block 17 S1: themed list look (optional) and home-page pin */
  themed?: boolean;
  emoji?: string | null;
  coverColor?: string | null;
  pinned?: boolean;
  id: string;
  name: string;
  description: string | null;
  owner: { id: string; name: string };
  role: 'owner' | 'editor' | 'viewer';
  items: string[];
  members: Array<{ id: string; name: string; role: 'editor' | 'viewer' }>;
}
export const LIST_A = uuid(1);
export const LIST_B = uuid(2);
export const LIST_C = uuid(3);

export function seedLists(): MockList[] {
  return [
    { id: LIST_A, name: 'Filmabend', description: 'Für Freitag', owner: { id: 'u1', name: 'Tester' }, role: 'owner', items: [items[0]!.id, items[2]!.id], members: [{ id: 'u2', name: 'Anna', role: 'editor' }] },
    { id: LIST_B, name: 'Annas Klassiker', description: null, owner: { id: 'u2', name: 'Anna' }, role: 'viewer', items: [items[4]!.id], members: [] },
    { id: LIST_C, name: 'Leer', description: null, owner: { id: 'u1', name: 'Tester' }, role: 'owner', items: [], members: [] },
  ];
}
