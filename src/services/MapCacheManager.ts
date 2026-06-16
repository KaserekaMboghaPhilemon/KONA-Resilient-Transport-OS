/**
 * Sprint 6 – Offline Map Tile Pre-Fetching Architecture
 *
 * Manages a local tile cache for offline map rendering on KONA driver devices.
 * Translates geographic coordinates into Slippy Map XYZ tile coordinates using
 * the Web Mercator projection (EPSG:3857), enumerates every tile covering a
 * route's bounding box, and pre-fetches them into an isolated directory inside
 * the device's cache folder so maps render without network connectivity.
 *
 * Cache directory layout:
 *   {cacheDirectory}/kona_map_tiles/{z}/{x}/{y}.png
 *
 * Tile coordinate math — Web Mercator translation matrix:
 *
 *   Given latitude φ (radians) and longitude λ (degrees) at zoom level z:
 *
 *   x = ⌊ (λ + 180) / 360 × 2^z ⌋
 *
 *   y = ⌊ (1 − ln(tan(φ) + sec(φ)) / π) / 2 × 2^z ⌋
 *       where sec(φ) = 1 / cos(φ)  (Gudermannian inverse)
 *
 *   y increases from north (0) to south (2^z − 1), matching the standard OSM /
 *   Google Maps tile addressing scheme.
 *
 * Operational guarantees:
 *   - Already-cached tiles are detected via getInfoAsync and skipped without a
 *     network request.
 *   - Filesystem and HTTP errors are caught per-tile and recorded in the result
 *     summary. A single bad tile never aborts the remaining fetch loop.
 *   - An empty route returns immediately with all-zero counts.
 *
 * Dependencies: expo-file-system (tile I/O only). No React Native imports.
 */

import * as FileSystem from 'expo-file-system/legacy';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Canonical XYZ tile address in the Slippy Map / Web Mercator scheme. */
export interface TileCoordinate {
  /** Column index — increases west→east. Range: [0, 2^z). */
  x: number;
  /** Row index — increases north→south. Range: [0, 2^z). */
  y: number;
  /** Zoom level. Range: [0, 22]. */
  z: number;
}

/** A geographic waypoint along a route path. */
export interface RoutePoint {
  latitude: number;
  longitude: number;
}

/** Options governing a single prefetchRouteTiles() call. */
export interface TilePrefetchOptions {
  /**
   * Zoom levels to pre-fetch tiles for, e.g. [12, 13, 14, 15].
   * Processing is sequential within each zoom level and across levels.
   */
  zoomLevels: number[];

  /**
   * Tile server URL template. Must contain `{z}`, `{x}`, and `{y}`
   * placeholders that will be replaced with the tile's coordinates.
   *
   * Example: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
   */
  tileServerUrl: string;

  /**
   * Number of extra tile rows/columns to include beyond the strict bounding
   * box edge on every side. Ensures smooth panning at the route margins.
   * Defaults to 1. Set to 0 to fetch only tiles the route itself crosses.
   */
  tilePaddingRadius?: number;
}

/** Outcome summary returned by prefetchRouteTiles(). */
export interface TilePrefetchResult {
  /** Total number of tiles enumerated across all zoom levels. */
  requested: number;
  /** Tiles that were not cached and downloaded successfully. */
  downloaded: number;
  /** Tiles already present in the local cache — skipped without a request. */
  skipped_cached: number;
  /** Tiles that could not be downloaded due to a network or HTTP error. */
  failed: number;
  /** Per-tile error records for every failure. */
  errors: Array<{ tile: TileCoordinate; message: string }>;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Root subdirectory name inside the device cache folder. */
const TILE_CACHE_FOLDER = 'kona_map_tiles';

/** Inclusive zoom level bounds supported by the Slippy Map scheme. */
const MIN_ZOOM_LEVEL = 0;
const MAX_ZOOM_LEVEL = 22;

/** Default tile padding applied when tilePaddingRadius is not specified. */
const DEFAULT_PADDING_RADIUS = 1;

/**
 * Web Mercator projection is undefined at ±90°. Clamp to the practical limits
 * used by OpenStreetMap so the Gudermannian inverse stays well-defined.
 */
const MAX_MERCATOR_LATITUDE = 85.051129;

// ---------------------------------------------------------------------------
// MapCacheManager
// ---------------------------------------------------------------------------

export class MapCacheManager {
  /**
   * Absolute local-filesystem path to the isolated tile cache root directory.
   * Always ends with a forward slash so path concatenation is consistent.
   */
  private readonly cacheRoot: string;

  /**
   * @param cacheBaseDir  Optional override for the cache base directory.
   *                      Falls back to FileSystem.cacheDirectory. If both are
   *                      unavailable the cache root degrades to a relative path.
   */
  constructor(cacheBaseDir?: string) {
    const base = cacheBaseDir ?? FileSystem.cacheDirectory ?? '';
    // Normalise: ensure base always has a trailing slash before appending the
    // tile folder name so the path is well-formed regardless of input format.
    const normalisedBase = base.endsWith('/') ? base : `${base}/`;
    this.cacheRoot = `${normalisedBase}${TILE_CACHE_FOLDER}/`;
  }

  // -------------------------------------------------------------------------
  // Initialisation
  // -------------------------------------------------------------------------

  /**
   * Ensures the root tile cache directory (and any intermediate paths) exist
   * on the device's filesystem before the first tile is written.
   *
   * Idempotent — safe to call multiple times. Any filesystem error (including
   * "directory already exists") is absorbed with a warning so a boot-time
   * initialisation failure never crashes the application.
   */
  async initialize(): Promise<void> {
    try {
      await FileSystem.makeDirectoryAsync(this.cacheRoot, { intermediates: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[MapCacheManager] initialize: ${msg}`);
    }
  }

  // -------------------------------------------------------------------------
  // Coordinate math — Web Mercator translation matrix
  // -------------------------------------------------------------------------

  /**
   * Converts a geographic coordinate to its Slippy Map XYZ tile address at
   * the requested zoom level using the Web Mercator projection formula.
   *
   * Translation matrix:
   *
   *   scale = 2^z
   *   x     = ⌊ (λ + 180) / 360 × scale ⌋
   *   y     = ⌊ (1 − ln(tan(φ) + 1/cos(φ)) / π) / 2 × scale ⌋
   *
   * where φ is the latitude in radians and λ is the longitude in degrees.
   * The Gudermannian inverse term ln(tan(φ) + sec(φ)) maps the spherical
   * latitude to a linear Mercator y-coordinate; dividing by π and rescaling
   * produces the row index that increases from north (y=0) to south (y=2^z−1).
   *
   * Latitude is clamped to ±MAX_MERCATOR_LATITUDE to prevent logarithm
   * singularities approaching the geographic poles.
   *
   * @throws {RangeError} When zoom is outside [MIN_ZOOM_LEVEL, MAX_ZOOM_LEVEL].
   */
  latLngToTile(latitude: number, longitude: number, zoom: number): TileCoordinate {
    if (zoom < MIN_ZOOM_LEVEL || zoom > MAX_ZOOM_LEVEL) {
      throw new RangeError(
        `Zoom level ${zoom} is outside the supported range ` +
          `[${MIN_ZOOM_LEVEL}, ${MAX_ZOOM_LEVEL}].`,
      );
    }

    // Clamp latitude to the valid Mercator range to avoid ln(0) singularities.
    const clampedLat = Math.max(
      -MAX_MERCATOR_LATITUDE,
      Math.min(MAX_MERCATOR_LATITUDE, latitude),
    );

    const z = Math.floor(zoom);
    const scale = Math.pow(2, z);

    // X axis: linear mapping of longitude [-180, 180] → [0, scale).
    const x = Math.floor(((longitude + 180) / 360) * scale);

    // Y axis: Gudermannian inverse applied to latitude in radians.
    const latRad = (clampedLat * Math.PI) / 180;
    const y = Math.floor(
      ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale,
    );

    return { x, y, z };
  }

  // -------------------------------------------------------------------------
  // Bounding-box enumeration
  // -------------------------------------------------------------------------

  /**
   * Returns every tile coordinate that covers the axis-aligned bounding box
   * of the supplied route points at a given zoom level.
   *
   * The bounding box is expanded by `paddingRadius` tiles on each side
   * (clamped to the valid [0, 2^z − 1] range) so that the driver can pan
   * slightly beyond the route boundary without hitting uncached tiles.
   *
   * Tile rows are ordered from top-left to bottom-right (x-major, then y).
   * Because y increases southward, the tile at the route's northern extreme
   * (maxLat) produces the smallest y index.
   *
   * @returns An array of TileCoordinate objects; empty when routePoints is empty.
   */
  getBoundingBoxTiles(
    routePoints: RoutePoint[],
    zoom: number,
    paddingRadius = DEFAULT_PADDING_RADIUS,
  ): TileCoordinate[] {
    if (routePoints.length === 0) return [];

    // Compute the geographic bounding box from all route waypoints.
    let minLat = routePoints[0]!.latitude;
    let maxLat = routePoints[0]!.latitude;
    let minLng = routePoints[0]!.longitude;
    let maxLng = routePoints[0]!.longitude;

    for (const pt of routePoints) {
      if (pt.latitude < minLat) minLat = pt.latitude;
      if (pt.latitude > maxLat) maxLat = pt.latitude;
      if (pt.longitude < minLng) minLng = pt.longitude;
      if (pt.longitude > maxLng) maxLng = pt.longitude;
    }

    // Convert bounding corners to tile space.
    // maxLat (north) → top-left; minLat (south) → bottom-right.
    const topLeft = this.latLngToTile(maxLat, minLng, zoom);
    const bottomRight = this.latLngToTile(minLat, maxLng, zoom);

    // Expand by padding radius, clamping to valid tile-index range.
    const maxTileIndex = Math.pow(2, zoom) - 1;
    const minX = Math.max(0, topLeft.x - paddingRadius);
    const maxX = Math.min(maxTileIndex, bottomRight.x + paddingRadius);
    const minY = Math.max(0, topLeft.y - paddingRadius);
    const maxY = Math.min(maxTileIndex, bottomRight.y + paddingRadius);

    const tiles: TileCoordinate[] = [];
    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        tiles.push({ x, y, z: zoom });
      }
    }

    return tiles;
  }

  // -------------------------------------------------------------------------
  // Cache helpers
  // -------------------------------------------------------------------------

  /**
   * Returns the absolute local filesystem path at which the given tile is
   * (or would be) stored:
   *   {cacheRoot}/{z}/{x}/{y}.png
   */
  getTileCachePath(tile: TileCoordinate): string {
    return `${this.cacheRoot}${tile.z}/${tile.x}/${tile.y}.png`;
  }

  /**
   * Queries the filesystem to determine whether a tile is already present in
   * the local cache. Returns false on any filesystem error to err on the side
   * of re-downloading rather than silently serving a corrupt or missing file.
   */
  async isTileCached(tile: TileCoordinate): Promise<boolean> {
    try {
      const info = await FileSystem.getInfoAsync(this.getTileCachePath(tile));
      return info.exists;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Download primitive
  // -------------------------------------------------------------------------

  /**
   * Downloads a single tile from the tile server and writes it to the local
   * cache path. Creates the intermediate z/x/ subdirectory tree as needed.
   *
   * URL construction replaces the `{z}`, `{x}`, and `{y}` placeholders in
   * tileServerUrl with the tile's numeric coordinates.
   *
   * @throws {Error} On HTTP non-200 status or filesystem write failure.
   *         Callers (prefetchRouteTiles) are responsible for catching and
   *         recording errors so the wider pre-fetch loop continues.
   */
  private async downloadTile(tile: TileCoordinate, tileServerUrl: string): Promise<void> {
    // Substitute coordinate placeholders in the tile server URL template.
    const remoteUrl = tileServerUrl
      .replace('{z}', String(tile.z))
      .replace('{x}', String(tile.x))
      .replace('{y}', String(tile.y));

    const localPath = this.getTileCachePath(tile);

    // Ensure the z/x/ subdirectory exists before expo-file-system writes to it.
    const tileDir = `${this.cacheRoot}${tile.z}/${tile.x}/`;
    await FileSystem.makeDirectoryAsync(tileDir, { intermediates: true });

    const result = await FileSystem.downloadAsync(remoteUrl, localPath);

    if (result.status !== 200) {
      throw new Error(
        `Tile server responded with HTTP ${result.status} for ${remoteUrl}`,
      );
    }

    console.log(
      `[MapCacheManager] tile cached z=${tile.z} x=${tile.x} y=${tile.y} → ${localPath}`,
    );
  }

  // -------------------------------------------------------------------------
  // Main pre-fetch API
  // -------------------------------------------------------------------------

  /**
   * Pre-fetches all map tiles covering the bounding box of the supplied route
   * at every requested zoom level, writing them to the isolated local cache so
   * they are available for offline rendering.
   *
   * Processing guarantees:
   *   – `initialize()` is called once at entry so the cache directory always
   *     exists before any tile write is attempted.
   *   – Each tile is checked for cache presence before requesting the network;
   *     already-cached tiles are skipped without any network activity.
   *   – Per-tile failures (network errors, non-200 HTTP responses, filesystem
   *     write errors) are captured in the result's `errors` array and never
   *     rethrown, preventing a single bad tile from stalling the batch.
   *   – An empty route returns immediately with all-zero counts.
   *
   * @param routePoints  Ordered waypoints describing the route geometry.
   * @param options      Zoom levels, tile server URL template, and padding.
   * @returns            TilePrefetchResult with per-tile outcome counts.
   */
  async prefetchRouteTiles(
    routePoints: RoutePoint[],
    options: TilePrefetchOptions,
  ): Promise<TilePrefetchResult> {
    const {
      zoomLevels,
      tileServerUrl,
      tilePaddingRadius = DEFAULT_PADDING_RADIUS,
    } = options;

    // Guard: no work to do for an empty route.
    if (routePoints.length === 0) {
      return { requested: 0, downloaded: 0, skipped_cached: 0, failed: 0, errors: [] };
    }

    // Ensure the cache root directory exists before writing any tiles.
    await this.initialize();

    const result: TilePrefetchResult = {
      requested: 0,
      downloaded: 0,
      skipped_cached: 0,
      failed: 0,
      errors: [],
    };

    for (const zoom of zoomLevels) {
      const tiles = this.getBoundingBoxTiles(routePoints, zoom, tilePaddingRadius);
      result.requested += tiles.length;

      for (const tile of tiles) {
        // Skip the network entirely when the tile is already on disk.
        const cached = await this.isTileCached(tile);
        if (cached) {
          result.skipped_cached++;
          continue;
        }

        // Attempt the download; record failures without interrupting the loop.
        try {
          await this.downloadTile(tile, tileServerUrl);
          result.downloaded++;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          result.failed++;
          result.errors.push({ tile, message });
          console.warn(
            `[MapCacheManager] failed tile z=${tile.z} x=${tile.x} y=${tile.y}: ${message}`,
          );
        }
      }
    }

    return result;
  }
}
