import { buildGfnGraphQlHeaders } from "./clientHeaders";
import { resolveVpcId } from "./session";

// GFN catalog constants
const GRAPHQL_URL = "https://games.geforce.com/graphql";
const APP_METADATA_QUERY_HASH = "cf8b620dfd03617017ba7c858cee65197e1ace5180e41be194b39227227ced63";
const DEFAULT_LOCALE = "en_US";
const DEFAULT_CATALOG_FETCH_COUNT = 120;
const MAX_CATALOG_PAGES = 3;
const DEFAULT_SORT_ID = "relevance";

// Local queue-bot DTOs
export interface GameVariant {
  id: string;
  store: string;
  storeUrl?: string;
  supportedControls: string[];
  gfnStatus?: string;
}

export interface GameInfo {
  id: string;
  uuid?: string;
  launchAppId?: string;
  title: string;
  imageUrl?: string;
  heroImageUrl?: string;
  publisherName?: string;
  developerName?: string;
  availableStores?: string[];
  searchText?: string;
  selectedVariantIndex: number;
  variants: GameVariant[];
}

export interface CatalogBrowseRequest {
  token: string;
  providerStreamingBaseUrl?: string;
  searchQuery?: string;
  sortId?: string;
  filterIds?: string[];
  fetchCount?: number;
}

export interface CatalogBrowseResult {
  games: GameInfo[];
  numberReturned: number;
  numberSupported: number;
  totalCount: number;
  hasNextPage: boolean;
  endCursor?: string;
  searchQuery: string;
}

export interface CatalogFilterGroup {
  id: string;
  label: string;
  options: Array<{
    id: string;
    rawId: string;
    label: string;
    groupId: string;
    groupLabel: string;
  }>;
}

export interface CatalogSortOption {
  id: string;
  label: string;
  orderBy: string;
}

interface CatalogDefinitions {
  filterGroups: CatalogFilterGroup[];
  sortOptions: CatalogSortOption[];
  filterPayloadById: Record<string, unknown>;
}

// Internal GraphQL types
interface AppData {
  id: string;
  title: string;
  shortName?: string;
  description?: string;
  longDescription?: string;
  developerName?: string;
  features?: unknown[];
  gameFeatures?: unknown[];
  appFeatures?: unknown[];
  genres?: unknown[];
  tags?: unknown[];
  supportedControls?: unknown[];
  nvidiaTech?: unknown[];
  maxLocalPlayers?: number;
  maxOnlinePlayers?: number;
  images?: Record<string, string | string[] | undefined>;
  publisherName?: string;
  contentRatings?: unknown[];
  variants?: Array<{
    id: string;
    appStore: string;
    storeUrl?: string;
    supportedControls?: string[];
    gfn?: {
      status?: string;
      library?: {
        status?: string;
        selected?: boolean;
        lastPlayedDate?: string;
      };
    };
  }>;
  gfn?: {
    playType?: string;
    playabilityState?: string;
    minimumMembershipTierLabel?: string;
    catalogSkuStrings?: {
      SKU_BASED_TAG?: string[];
      SKU_BASED_PLAYABILITY_TEXT?: string;
      SKU_BASED_UNPLAYABLE_DIALOG_HEADER?: string;
      SKU_BASED_UNPLAYABLE_DIALOG_BODY_UPGRADE?: string;
      SKU_BASED_UNPLAYABLE_DIALOG_BODY_UPGRADE_ECOMM_RESTRICTED?: string;
    };
  };
}

interface AppMetaDataResponse {
  data?: {
    apps: {
      items: AppData[];
    };
  };
  errors?: Array<{ message: string }>;
}

interface FilterSortDefinitionsResponse {
  data?: {
    filterGroupDefinitions?: Array<{
      id: string;
      label: string;
      filters?: Array<{
        id: string;
        label: string;
        filters?: string[];
      }>;
    }>;
    sortOrderDefinitions?: Array<{
      id: string;
      label: string;
      orderBy: string;
    }>;
  };
  errors?: Array<{ message: string }>;
}

interface AppsSearchResponse {
  data?: {
    apps?: {
      numberReturned?: number;
      numberSupported?: number;
      pageInfo?: {
        hasNextPage?: boolean;
        endCursor?: string;
        totalCount?: number;
      };
      items?: AppData[];
    };
  };
  errors?: Array<{ message: string }>;
}

interface AppResolution {
  numericAppId?: string;
  preferredVariantId?: string;
  selectedVariantIndex: number;
}

const LANDSCAPE_IMAGE_KEYS = ["MARQUEE_HERO_IMAGE", "HERO_IMAGE", "TV_BANNER", "FEATURE_IMAGE", "KEY_IMAGE", "KEY_ART"] as const;
const POSTER_IMAGE_KEYS = ["GAME_BOX_ART", "KEY_IMAGE", "KEY_ART"] as const;

function optimizeImage(url: string, width = 272): string {
  if (url.includes("img.nvidiagrid.net")) {
    return `${url};f=webp;w=${width}`;
  }
  return url;
}

function normalizeImageValues(value: string | string[] | undefined, width: number): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return [...new Set(values.map((url) => url.trim()).filter(Boolean).map((url) => optimizeImage(url, width)))];
}

function getFirstImage(images: AppData["images"], keys: readonly string[], width: number): string | undefined {
  if (!images) return undefined;
  for (const key of keys) {
    const value = normalizeImageValues(images[key], width)[0];
    if (value) return value;
  }
  return undefined;
}

function isNumericId(value: string | undefined): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}

function randomHuId(): string {
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
}

async function postGraphQl<T>(query: string, variables: Record<string, unknown>, token?: string): Promise<T> {
  const response = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: buildGfnGraphQlHeaders(token),
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GFN GraphQL failed (${response.status}): ${text.slice(0, 400)}`);
  }

  return (await response.json()) as T;
}

function parseFeatureLabel(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    const keys = ["name", "label", "title", "displayName"];
    for (const key of keys) {
      const raw = candidate[key];
      if (typeof raw === "string") {
        const trimmed = raw.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    }
  }
  return null;
}

function extractFeatureLabels(app: AppData): string[] {
  const buckets: unknown[] = [
    app.features,
    app.gameFeatures,
    app.appFeatures,
    app.genres,
    app.tags,
    app.gfn?.catalogSkuStrings?.SKU_BASED_TAG,
  ];

  const labels: string[] = [];
  for (const bucket of buckets) {
    if (!Array.isArray(bucket)) {
      continue;
    }
    for (const entry of bucket) {
      const label = parseFeatureLabel(entry);
      if (label) {
        labels.push(label);
      }
    }
  }

  return [...new Set(labels)];
}

function extractGenres(app: AppData): string[] {
  if (!Array.isArray(app.genres)) {
    return [];
  }

  const genres: string[] = [];
  for (const entry of app.genres) {
    const genre = parseFeatureLabel(entry);
    if (genre) {
      genres.push(genre);
    }
  }

  return [...new Set(genres)];
}

function buildSearchText(
  title: string,
  variants: GameVariant[],
  genres: string[],
  featureLabels: string[],
  publisherName?: string,
  developerName?: string
): string {
  const stores = variants.map((variant) => variant.store);
  return [title, publisherName, developerName, ...stores, ...genres, ...featureLabels]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
}

function resolveAppData(app: AppData): AppResolution {
  const variants = app.variants ?? [];
  const selectedVariantIndex = variants.findIndex((variant) => variant.gfn?.library?.selected === true);
  const preferredVariant = selectedVariantIndex >= 0 ? variants[selectedVariantIndex] : undefined;
  const numericVariants = variants.filter((variant) => isNumericId(variant.id));
  const preferredNumericVariant = preferredVariant && isNumericId(preferredVariant.id) ? preferredVariant.id : undefined;
  const fallbackNumericVariant = numericVariants[0]?.id;
  const numericAppId = preferredNumericVariant ?? fallbackNumericVariant ?? (isNumericId(app.id) ? app.id : undefined);
  const preferredVariantId = preferredVariant?.id ?? numericAppId ?? variants[0]?.id ?? app.id;

  return {
    numericAppId,
    preferredVariantId,
    selectedVariantIndex: selectedVariantIndex >= 0 ? selectedVariantIndex : Math.max(0, variants.findIndex((variant) => variant.id === preferredVariantId)),
  };
}

function appToVariants(app: AppData): GameVariant[] {
  return app.variants?.map((variant) => ({
    id: variant.id,
    store: variant.appStore,
    storeUrl: variant.storeUrl,
    supportedControls: variant.supportedControls ?? [],
    gfnStatus: variant.gfn?.status,
  })) ?? [];
}

function appToGame(app: AppData): GameInfo {
  const variants = appToVariants(app);
  const resolution = resolveAppData(app);
  const heroImageUrl = getFirstImage(app.images, LANDSCAPE_IMAGE_KEYS, 1200);
  const posterImageUrl = getFirstImage(app.images, POSTER_IMAGE_KEYS, 900);
  const imageUrl = heroImageUrl ?? posterImageUrl;
  const genres = extractGenres(app);
  const featureLabels = extractFeatureLabels(app);

  return {
    id: app.id,
    uuid: app.id,
    launchAppId: resolution.numericAppId,
    title: app.title,
    imageUrl,
    heroImageUrl,
    publisherName: app.publisherName,
    developerName: app.developerName,
    availableStores: [...new Set(variants.map((variant) => variant.store).filter(Boolean))],
    searchText: buildSearchText(app.title, variants, genres, featureLabels, app.publisherName, app.developerName),
    selectedVariantIndex: Math.max(0, Math.min(resolution.selectedVariantIndex, Math.max(variants.length - 1, 0))),
    variants,
  };
}

function dedupeGames(games: GameInfo[]): GameInfo[] {
  const byId = new Map<string, GameInfo>();

  for (const game of games) {
    const existing = byId.get(game.id);
    if (!existing) {
      byId.set(game.id, game);
      continue;
    }

    const mergedVariants = new Map<string, GameVariant>();
    for (const variant of [...existing.variants, ...game.variants]) {
      mergedVariants.set(variant.id, variant);
    }

    const mergedVariantsList = [...mergedVariants.values()];
    const selectedVariantId =
      existing.variants[existing.selectedVariantIndex]?.id ??
      game.variants[game.selectedVariantIndex]?.id;
    const selectedVariantIndex = selectedVariantId
      ? mergedVariantsList.findIndex((variant) => variant.id === selectedVariantId)
      : -1;
    const merged: GameInfo = {
      ...existing,
      ...game,
      id: existing.id,
      uuid: existing.uuid ?? game.uuid,
      launchAppId: existing.launchAppId ?? game.launchAppId,
      title: existing.title || game.title,
      imageUrl: existing.imageUrl ?? game.imageUrl,
      heroImageUrl: existing.heroImageUrl ?? game.heroImageUrl,
      publisherName: existing.publisherName ?? game.publisherName,
      developerName: existing.developerName ?? game.developerName,
      availableStores: [...new Set([...(existing.availableStores ?? []), ...(game.availableStores ?? [])])],
      searchText: [existing.searchText, game.searchText].filter(Boolean).join(" ").trim() || undefined,
      selectedVariantIndex: selectedVariantIndex >= 0 ? selectedVariantIndex : 0,
      variants: mergedVariantsList,
    };

    byId.set(game.id, merged);
  }

  return [...byId.values()];
}

function mergeAppMetaIntoGame(game: GameInfo, app: AppData): GameInfo {
  const merged = appToGame(app);
  const selectedVariantId = game.variants[game.selectedVariantIndex]?.id;
  const selectedVariantIndex = selectedVariantId
    ? merged.variants.findIndex((variant) => variant.id === selectedVariantId)
    : -1;

  return {
    ...game,
    ...merged,
    id: game.id,
    selectedVariantIndex: selectedVariantIndex >= 0 ? selectedVariantIndex : merged.selectedVariantIndex,
  };
}

async function fetchAppMetaData(
  token: string,
  appIds: string[],
  vpcId: string,
): Promise<AppMetaDataResponse> {
  const normalizedIds = [...new Set(appIds.map((id) => id.trim()).filter((id) => id.length > 0))];
  if (normalizedIds.length === 0) {
    return { data: { apps: { items: [] } } };
  }

  const variables = JSON.stringify({
    vpcId,
    locale: DEFAULT_LOCALE,
    appIds: normalizedIds,
  });

  const extensions = JSON.stringify({
    persistedQuery: {
      sha256Hash: APP_METADATA_QUERY_HASH,
    },
  });

  const params = new URLSearchParams({
    requestType: "appMetaData",
    extensions,
    huId: randomHuId(),
    variables,
  });

  const response = await fetch(`${GRAPHQL_URL}?${params.toString()}`, {
    headers: {
      ...buildGfnGraphQlHeaders(token),
      "Content-Type": "application/graphql",
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`App metadata failed (${response.status}): ${text.slice(0, 400)}`);
  }

  return (await response.json()) as AppMetaDataResponse;
}

async function enrichGamesWithMetadata(token: string, vpcId: string, games: GameInfo[]): Promise<GameInfo[]> {
  const uuids = [...new Set(games.map((game) => game.uuid).filter((uuid): uuid is string => !!uuid))];

  if (uuids.length === 0) {
    return games;
  }

  const chunkSize = 40;
  const appById = new Map<string, AppData>();

  for (let index = 0; index < uuids.length; index += chunkSize) {
    const chunk = uuids.slice(index, index + chunkSize);
    const payload = await fetchAppMetaData(token, chunk, vpcId);
    if (payload.errors?.length) {
      throw new Error(payload.errors.map((error) => error.message).join(", "));
    }

    for (const app of payload.data?.apps.items ?? []) {
      appById.set(app.id, app);
    }
  }

  return dedupeGames(
    games.map((game) => {
      const metadata = game.uuid ? appById.get(game.uuid) : undefined;
      return metadata ? mergeAppMetaIntoGame(game, metadata) : game;
    }),
  );
}

async function fetchFilterAndSortDefinitions(token?: string): Promise<CatalogDefinitions> {
  const query = `query GetFilterGroupAndSortOrderDefinitions($locale: String!) {
    filterGroupDefinitions(language: $locale) {
      id
      label
      filters {
        id
        label
        filters
      }
    }
    sortOrderDefinitions(language: $locale) {
      id
      label
      orderBy
    }
  }`;

  const payload = await postGraphQl<FilterSortDefinitionsResponse>(query, { locale: DEFAULT_LOCALE }, token);
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join(", "));
  }

  const filterPayloadById: Record<string, unknown> = {};
  const filterGroups: CatalogFilterGroup[] = [];

  for (const group of payload.data?.filterGroupDefinitions ?? []) {
    const options = (group.filters ?? []).flatMap((entry) => {
      const filterJson = entry.filters?.[0];
      if (!filterJson) {
        return [];
      }
      try {
        filterPayloadById[entry.id] = JSON.parse(filterJson);
        return [{
          id: entry.id,
          rawId: entry.id,
          label: entry.label,
          groupId: group.id,
          groupLabel: group.label,
        }];
      } catch {
        return [];
      }
    });

    if (options.length > 0) {
      filterGroups.push({ id: group.id, label: group.label, options });
    }
  }

  const sortOptions = (payload.data?.sortOrderDefinitions ?? []).map((sort) => ({
    id: sort.id,
    label: sort.label,
    orderBy: sort.orderBy,
  }));

  return {
    filterGroups,
    sortOptions,
    filterPayloadById,
  };
}

function mergeFilterPayloads(filterIds: string[], filterPayloadById: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {};

  for (const filterId of filterIds) {
    const payload = filterPayloadById[filterId];
    if (!payload || typeof payload !== "object") {
      continue;
    }
    Object.assign(merged, payload as Record<string, unknown>);
  }

  return merged;
}

export async function browseCatalogUncached(input: CatalogBrowseRequest): Promise<CatalogBrowseResult> {
  const token = input.token;
  if (!token) {
    throw new Error("Catalog browsing requires an authenticated token");
  }

  const vpcId = await resolveVpcId(token, input.providerStreamingBaseUrl);
  const definitions = await fetchFilterAndSortDefinitions(token);
  const normalizedFilterIds = (input.filterIds ?? []).filter((id) => id in definitions.filterPayloadById);
  const selectedSort = definitions.sortOptions.find((option) => option.id === input.sortId)
    ?? definitions.sortOptions.find((option) => option.id === DEFAULT_SORT_ID)
    ?? definitions.sortOptions[0]
    ?? { id: DEFAULT_SORT_ID, label: "Relevance", orderBy: "itemMetadata.relevance:DESC,sortName:ASC" };
  const searchQuery = input.searchQuery?.trim() ?? "";
  const fetchCount = Math.max(24, Math.min(input.fetchCount ?? DEFAULT_CATALOG_FETCH_COUNT, 200));
  const filters = mergeFilterPayloads(normalizedFilterIds, definitions.filterPayloadById);

  const appFields = `
      numberReturned
      numberSupported
      pageInfo { hasNextPage endCursor totalCount }
      items {
        id
        title
        images { KEY_ART KEY_IMAGE GAME_BOX_ART TV_BANNER HERO_IMAGE MARQUEE_HERO_IMAGE FEATURE_IMAGE GAME_LOGO SCREENSHOTS }
        variants {
          id
          appStore
          storeUrl
          supportedControls
          gfn {
            status
            library { status selected }
          }
        }
        gfn {
          playabilityState
          minimumMembershipTierLabel
          catalogSkuStrings {
            SKU_BASED_TAG
            SKU_BASED_PLAYABILITY_TEXT
            SKU_BASED_UNPLAYABLE_DIALOG_HEADER
            SKU_BASED_UNPLAYABLE_DIALOG_BODY_UPGRADE
            SKU_BASED_UNPLAYABLE_DIALOG_BODY_UPGRADE_ECOMM_RESTRICTED
          }
        }
        itemMetadata { campaignIds }
      }
  `;

  const query = searchQuery.length > 0
    ? `query GetSearchFilterResults(
      $vpcId: String!,
      $locale: String!,
      $sortString: String!,
      $fetchCount: Int!,
      $cursor: String!,
      $searchString: String!,
      $filters: AppFilterFields!
    ) {
      apps(
        vpcId: $vpcId,
        language: $locale,
        orderBy: $sortString,
        first: $fetchCount,
        after: $cursor,
        searchQuery: $searchString,
        filters: $filters
      ) {
${appFields}
      }
    }`
    : `query GetFilterBrowseResults(
      $vpcId: String!,
      $locale: String!,
      $sortString: String!,
      $fetchCount: Int!,
      $cursor: String!,
      $filters: AppFilterFields!
    ) {
      apps(
        vpcId: $vpcId,
        language: $locale,
        orderBy: $sortString,
        first: $fetchCount,
        after: $cursor,
        filters: $filters
      ) {
${appFields}
      }
    }`;

  const collectedApps: AppData[] = [];
  let numberReturned = 0;
  let numberSupported = 0;
  let totalCount = 0;
  let hasNextPage = false;
  let endCursor = "";
  let cursor = "";

  for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
    const payload = await postGraphQl<AppsSearchResponse>(
      query,
      searchQuery.length > 0
        ? {
            vpcId,
            locale: DEFAULT_LOCALE,
            sortString: selectedSort.orderBy,
            fetchCount,
            cursor,
            searchString: searchQuery,
            filters,
          }
        : {
            vpcId,
            locale: DEFAULT_LOCALE,
            sortString: selectedSort.orderBy,
            fetchCount,
            cursor,
            filters,
          },
      token,
    );

    if (payload.errors?.length) {
      throw new Error(payload.errors.map((error) => error.message).join(", "));
    }

    const apps = payload.data?.apps;
    const items = apps?.items ?? [];
    collectedApps.push(...items);
    numberReturned += apps?.numberReturned ?? items.length;
    numberSupported = apps?.numberSupported ?? numberSupported;
    hasNextPage = apps?.pageInfo?.hasNextPage ?? false;
    endCursor = apps?.pageInfo?.endCursor ?? "";
    totalCount = apps?.pageInfo?.totalCount ?? totalCount;

    if (!hasNextPage || !endCursor) {
      break;
    }

    cursor = endCursor;
  }

  const games = dedupeGames(await enrichGamesWithMetadata(token, vpcId, collectedApps.map(appToGame)));

  return {
    games,
    numberReturned,
    numberSupported: Math.max(numberSupported, games.length),
    totalCount: Math.max(totalCount, games.length),
    hasNextPage,
    endCursor: endCursor || undefined,
    searchQuery,
  };
}

export async function browseCatalog(input: CatalogBrowseRequest): Promise<CatalogBrowseResult> {
  return browseCatalogUncached(input);
}
