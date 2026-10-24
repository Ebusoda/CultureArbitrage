// Hand-made sample data so the whole app runs before the Qloo key arrives.
// Numbers are invented. They are shaped to tell the same story we expect from
// real data (e.g. Shimokitazawa ≈ Williamsburg), not to be accurate.

export interface MockLocality {
  id: string;
  name: string;
  city: string;
  lat: number;
  lng: number;
  // taste tag id -> affinity (0..1)
  taste: Record<string, number>;
  // category tag id -> number of places
  supply: Record<string, number>;
}

export const TASTE_TAGS: Record<string, string> = {
  "urn:tag:mock:vintage": "Vintage fashion",
  "urn:tag:mock:indie_music": "Indie music",
  "urn:tag:mock:kpop": "K-pop",
  "urn:tag:mock:anime": "Anime",
  "urn:tag:mock:third_wave_coffee": "Third-wave coffee",
  "urn:tag:mock:wellness": "Wellness",
  "urn:tag:mock:streetwear": "Streetwear",
  "urn:tag:mock:chinese_cuisine": "Chinese cuisine",
  "urn:tag:mock:punk": "Punk",
  "urn:tag:mock:vinyl": "Vinyl records",
};

export const CATEGORY_TAGS: Record<string, string> = {
  "urn:tag:mock:place:natural_wine_bar": "Natural wine bar",
  "urn:tag:mock:place:malatang": "Malatang",
  "urn:tag:mock:place:bubble_tea": "Bubble tea",
  "urn:tag:mock:place:jazz_club": "Jazz club",
  "urn:tag:mock:place:korean_fried_chicken": "Korean fried chicken",
  "urn:tag:mock:place:bagel_shop": "Bagel shop",
  "urn:tag:mock:place:record_store": "Record store",
  "urn:tag:mock:place:comic_store": "Comic and manga store",
};

const t = (o: Record<string, number>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [`urn:tag:mock:${k}`, v]));
const s = (o: Record<string, number>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [`urn:tag:mock:place:${k}`, v]));

export const LOCALITIES: MockLocality[] = [
  // Tokyo
  {
    id: "urn:entity:locality:mock:shimokitazawa", name: "Shimokitazawa", city: "Tokyo", lat: 35.6616, lng: 139.6682,
    taste: t({ vintage: 0.92, indie_music: 0.88, vinyl: 0.8, third_wave_coffee: 0.75, punk: 0.4, wellness: 0.35 }),
    supply: s({ natural_wine_bar: 2, jazz_club: 12, record_store: 14, bagel_shop: 1, bubble_tea: 3, malatang: 0 }),
  },
  {
    id: "urn:entity:locality:mock:ikebukuro", name: "Ikebukuro", city: "Tokyo", lat: 35.7295, lng: 139.7109,
    taste: t({ anime: 0.9, chinese_cuisine: 0.82, kpop: 0.55, streetwear: 0.35, wellness: 0.3 }),
    supply: s({ malatang: 6, bubble_tea: 9, korean_fried_chicken: 3, comic_store: 2 }),
  },
  {
    id: "urn:entity:locality:mock:shin_okubo", name: "Shin-Okubo", city: "Tokyo", lat: 35.7013, lng: 139.7005,
    taste: t({ kpop: 0.95, wellness: 0.6, streetwear: 0.45, chinese_cuisine: 0.3 }),
    supply: s({ korean_fried_chicken: 18, comic_store: 15, bubble_tea: 7, malatang: 2 }),
  },
  {
    id: "urn:entity:locality:mock:koenji", name: "Koenji", city: "Tokyo", lat: 35.7056, lng: 139.6496,
    taste: t({ punk: 0.85, vintage: 0.8, indie_music: 0.7, vinyl: 0.65 }),
    supply: s({ record_store: 9, jazz_club: 2, natural_wine_bar: 1 }),
  },
  {
    id: "urn:entity:locality:mock:shibuya", name: "Shibuya", city: "Tokyo", lat: 35.658, lng: 139.7016,
    taste: t({ streetwear: 0.85, kpop: 0.6, third_wave_coffee: 0.6, wellness: 0.55, vinyl: 0.4 }),
    supply: s({ bubble_tea: 12, natural_wine_bar: 5, jazz_club: 6, malatang: 3, comic_store: 6, record_store: 7 }),
  },
  // New York
  {
    id: "urn:entity:locality:mock:williamsburg", name: "Williamsburg", city: "New York", lat: 40.7081, lng: -73.9571,
    taste: t({ vintage: 0.9, indie_music: 0.9, vinyl: 0.78, third_wave_coffee: 0.82, wellness: 0.45 }),
    supply: s({ natural_wine_bar: 21, jazz_club: 8, record_store: 12, bagel_shop: 9, bubble_tea: 2 }),
  },
  {
    id: "urn:entity:locality:mock:east_village", name: "East Village", city: "New York", lat: 40.7265, lng: -73.9815,
    taste: t({ punk: 0.82, vintage: 0.7, indie_music: 0.65, vinyl: 0.6 }),
    supply: s({ record_store: 8, natural_wine_bar: 11, jazz_club: 3, bagel_shop: 6 }),
  },
  {
    id: "urn:entity:locality:mock:flushing", name: "Flushing", city: "New York", lat: 40.7675, lng: -73.833,
    taste: t({ chinese_cuisine: 0.95, kpop: 0.5, anime: 0.35, wellness: 0.3 }),
    supply: s({ malatang: 14, bubble_tea: 16, korean_fried_chicken: 6 }),
  },
  {
    id: "urn:entity:locality:mock:koreatown_ny", name: "Koreatown", city: "New York", lat: 40.7477, lng: -73.9869,
    taste: t({ kpop: 0.9, wellness: 0.55, streetwear: 0.4 }),
    supply: s({ korean_fried_chicken: 10, comic_store: 8, bubble_tea: 5 }),
  },
  // Seoul
  {
    id: "urn:entity:locality:mock:hongdae", name: "Hongdae", city: "Seoul", lat: 37.5563, lng: 126.9236,
    taste: t({ indie_music: 0.85, kpop: 0.7, vintage: 0.6, third_wave_coffee: 0.6, wellness: 0.5 }),
    supply: s({ malatang: 11, jazz_club: 5, natural_wine_bar: 4, bubble_tea: 8 }),
  },
  {
    id: "urn:entity:locality:mock:seongsu", name: "Seongsu", city: "Seoul", lat: 37.5446, lng: 127.0559,
    taste: t({ third_wave_coffee: 0.92, streetwear: 0.75, vintage: 0.6, wellness: 0.5, vinyl: 0.45 }),
    supply: s({ natural_wine_bar: 9, jazz_club: 7, bagel_shop: 8, malatang: 4 }),
  },
  {
    id: "urn:entity:locality:mock:myeongdong", name: "Myeongdong", city: "Seoul", lat: 37.5637, lng: 126.9838,
    taste: t({ kpop: 0.85, wellness: 0.7, streetwear: 0.5, chinese_cuisine: 0.4 }),
    supply: s({ comic_store: 25, malatang: 6, korean_fried_chicken: 7, bubble_tea: 24 }),
  },
];

// The explorable city list lives in lib/cities.ts; re-exported for older imports.
export { CITIES } from "../cities";

// Audience demographics: share of each age band / gender among people with
// affinity for a category (or living in a neighbourhood). Shape is a guess at
// Qloo's urn:demographics output; check against real data.
export interface MockDemographics {
  age: Record<string, number>;
  gender: Record<string, number>;
}

const demo = (a: number[], female: number): MockDemographics => ({
  age: { "24_and_younger": a[0], "25_to_29": a[1], "30_to_34": a[2], "35_to_44": a[3], "45_and_older": a[4] },
  gender: { female, male: Math.round((1 - female) * 100) / 100 },
});

export const CATEGORY_DEMOGRAPHICS: Record<string, MockDemographics> = {
  "urn:tag:mock:place:natural_wine_bar": demo([0.08, 0.3, 0.32, 0.22, 0.08], 0.55),
  "urn:tag:mock:place:malatang": demo([0.45, 0.3, 0.12, 0.08, 0.05], 0.82),
  "urn:tag:mock:place:bubble_tea": demo([0.55, 0.25, 0.1, 0.06, 0.04], 0.7),
  "urn:tag:mock:place:jazz_club": demo([0.06, 0.24, 0.3, 0.28, 0.12], 0.4),
  "urn:tag:mock:place:korean_fried_chicken": demo([0.35, 0.3, 0.18, 0.12, 0.05], 0.6),
  "urn:tag:mock:place:bagel_shop": demo([0.15, 0.3, 0.28, 0.18, 0.09], 0.58),
  "urn:tag:mock:place:record_store": demo([0.12, 0.22, 0.24, 0.26, 0.16], 0.35),
  "urn:tag:mock:place:comic_store": demo([0.5, 0.3, 0.12, 0.05, 0.03], 0.9),
};

export const LOCALITY_DEMOGRAPHICS: Record<string, MockDemographics> = {
  Shimokitazawa: demo([0.28, 0.32, 0.2, 0.13, 0.07], 0.52),
  Ikebukuro: demo([0.38, 0.27, 0.15, 0.12, 0.08], 0.58),
  "Shin-Okubo": demo([0.45, 0.27, 0.12, 0.1, 0.06], 0.72),
  Koenji: demo([0.2, 0.28, 0.22, 0.18, 0.12], 0.45),
  Shibuya: demo([0.35, 0.3, 0.17, 0.12, 0.06], 0.55),
  Williamsburg: demo([0.12, 0.33, 0.3, 0.17, 0.08], 0.5),
  "East Village": demo([0.18, 0.3, 0.25, 0.17, 0.1], 0.48),
  Flushing: demo([0.22, 0.2, 0.18, 0.2, 0.2], 0.52),
  Koreatown: demo([0.3, 0.3, 0.2, 0.13, 0.07], 0.56),
  Hongdae: demo([0.42, 0.3, 0.14, 0.09, 0.05], 0.57),
  Seongsu: demo([0.25, 0.33, 0.22, 0.13, 0.07], 0.55),
  Myeongdong: demo([0.4, 0.28, 0.14, 0.11, 0.07], 0.68),
};

// Monthly popularity index over the last 12 months. Bubble tea is the
// "real gap, but fading" counterexample from the tapioca boom.
const series = (start: number, end: number) =>
  Array.from({ length: 12 }, (_, i) => Math.round((start + ((end - start) * i) / 11) * 100) / 100);

export const CATEGORY_TRENDS: Record<string, number[]> = {
  "urn:tag:mock:place:natural_wine_bar": series(0.55, 0.78),
  "urn:tag:mock:place:malatang": series(0.4, 0.85),
  "urn:tag:mock:place:bubble_tea": series(0.9, 0.45),
  "urn:tag:mock:place:jazz_club": series(0.45, 0.7),
  "urn:tag:mock:place:korean_fried_chicken": series(0.62, 0.6),
  "urn:tag:mock:place:bagel_shop": series(0.5, 0.66),
  "urn:tag:mock:place:record_store": series(0.5, 0.52),
  "urn:tag:mock:place:comic_store": series(0.7, 0.68),
};
