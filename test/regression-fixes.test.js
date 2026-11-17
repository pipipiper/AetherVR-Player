"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function functionSource(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const bodyStart = html.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < html.length; i++) {
    if (html[i] === "{") depth++;
    if (html[i] === "}") depth--;
    if (depth === 0) return html.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

test("SMB queue contains the complete directory and uses stable UNC identities", () => {
  const calls = [];
  const context = {
    localUrl: (p) => `/local?path=${encodeURIComponent(p)}`,
    normalizePath: (p) => p,
    smbUNCFromPath: (p) => `\\\\nas\\share\\${p.split("/").pop()}`,
    lastDplEntries: null,
    ensureTempTab: () => ({ id: "temp" }),
    activeTab: "", activePlId: null, playedFromPosterWall: false, playOrigin: "",
    setCloudPlaying: () => {}, renderTabs: () => {},
    setPlaylist: (queue, index) => calls.push({ queue, index }),
    showSpatialToast: () => {},
  };
  vm.createContext(context);
  vm.runInContext(functionSource("playSmbFromQueue"), context);
  const files = [
    { name: "01.mp4", path: "/tmp/aethervr-smb/nas_share/01.mp4" },
    { name: "02.mp4", path: "/tmp/aethervr-smb/nas_share/02.mp4" },
  ];
  context.playSmbFromQueue(files[1], files);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].queue.length, 2);
  assert.equal(calls[0].index, 1);
  assert.ok(calls[0].queue.every((item) => item.originalPath.startsWith("\\\\nas\\share\\")));
  assert.ok(calls[0].queue.every((item) => !item.originalPath.includes("/tmp/")));
});

test("WebDAV queue contains every video and starts on the selected item", () => {
  const calls = [];
  const context = {
    normalizePath: (p) => p,
    lastDplEntries: null,
    ensureTempTab: () => ({ id: "temp" }),
    activeTab: "", activePlId: null, playedFromPosterWall: false, playOrigin: "",
    setCloudPlaying: () => {}, renderTabs: () => {},
    setPlaylist: (queue, index) => calls.push({ queue, index }),
    showSpatialToast: () => {},
  };
  vm.createContext(context);
  vm.runInContext(functionSource("playWebdavFromQueue"), context);
  const files = [{ name: "01.mp4", href: "/01.mp4" }, { name: "02.mp4", href: "/02.mp4" }];
  context.playWebdavFromQueue(files[0], files, (item) => "https://nas" + item.href);
  assert.equal(calls[0].queue.length, 2);
  assert.equal(calls[0].index, 0);
});

test("backup supports settings-only files and restores both WebDAV and SMB", () => {
  assert.match(html, /!data\.bookmarks && !data\.settings/);
  assert.match(html, /data\.servers\.filter\(s => s\.type === 'smb'\)/);
  assert.match(html, /getSmbServers\(\)\.forEach/);
  assert.match(html, /address: s\.host \+ \(s\.port/);
  assert.match(html, /id: s\.id \|\| stableSourceUUID\('webdav'\)/);
});

test("player has real hemisphere geometry, subtitle input, and audio selection", () => {
  assert.match(html, /projection === 'vr180' \? Math\.PI : Math\.PI \* 2/);
  assert.match(html, /function srtToVtt/);
  assert.match(html, /audioStream: index/);
  assert.match(html, /videoPlayer\.audioTracks/);
  assert.match(html, /Array\.from\(tracks\)/);
});

test("SMB poster snapshots use UNC and revive through the current mount", () => {
  const context = {
    URL, location: { origin: "http://localhost" },
    window: { vrDesktop: { platform: "darwin" } },
    localUrl: (p) => `/local?path=${encodeURIComponent(p)}&token=current`,
    portableMediaPath: (p) => p,
    posterWallCurrentSource: () => null,
    smbShareKey: (host, share) => `${host.toLowerCase()}/${share.toLowerCase()}`,
    posterWallSmbMountMap: new Map([
      ["nas/movies", { host: "nas", share: "movies", root: "/tmp/aethervr-smb/nas_movies" }],
    ]),
  };
  vm.createContext(context);
  context.globalThis = context;
  vm.runInContext([
    functionSource("resolveMountedSmbPath"),
    functionSource("pwReviveUrl"),
  ].join("\n"), context);
  const slash = String.fromCharCode(92);
  const unc = slash + slash + ["NAS", "Movies", "A", "poster.jpg"].join(slash);
  assert.equal(context.smbShareKey("NAS", "Movies"), "nas/movies");
  context.inputUNC = unc;
  const local = vm.runInContext("resolveMountedSmbPath(inputUNC)", context);
  assert.equal(local, "/tmp/aethervr-smb/nas_movies/A/poster.jpg");
  const revived = context.pwReviveUrl(`/local?path=${encodeURIComponent(unc)}&token=old`);
  const parsed = new URL(revived, "http://localhost");
  assert.equal(parsed.searchParams.get("path"), local);
  assert.equal(parsed.searchParams.get("token"), "current");
});

test("cloud rows expose working management and per-directory sorting", () => {
  assert.match(html, /bindCloudActions\(el, item, 'webdav'/);
  assert.match(html, /bindCloudActions\(el, item, 'smb'/);
  assert.match(html, /function sortCloudEntries/);
  assert.match(html, /aethervr-cloud-sort/);
});

test("bookmarks sort newest-added first at both video and timestamp levels", () => {
  const storage = new Map();
  const context = {
    Date, Math, Number, Array, Object, Set, Map, JSON,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
    getPlaybackHistory: () => [
      { url: "https://example.com/a.mp4", lastPlayedAt: 9999999999999 },
      { url: "https://example.com/b.mp4", lastPlayedAt: 1000 },
    ],
    posCurrentKey: "",
    videoPlayer: { dataset: {}, currentSrc: "" },
    bookmarkTrack: null,
    bookmarkBtn: null,
    effectiveDuration: () => 600,
    effectiveCurrentTime: () => 0,
    showSpatialToast: () => {},
    formatTime: (t) => String(t),
    document: { getElementById: () => ({ addEventListener: () => {}, value: "" }) },
  };
  vm.createContext(context);
  vm.runInContext([
    "const BOOKMARK_STORE_KEY = 'aethervr-bookmarks-v1';",
    "const BOOKMARK_META_KEY = 'aethervr-bookmarks-meta-v1';",
    "let bookmarkStore = { 'url:https://example.com/a.mp4': [10, 80], 'url:https://example.com/b.mp4': [20] };",
    "let bookmarkMeta = {};",
    "let lastBookmarkAddedAt = 0;",
    functionSource("normalizeBookmarkAddedAt"),
    functionSource("nextBookmarkTimestamp"),
    functionSource("findBookmarkMeta"),
    functionSource("reconcileAllBookmarkMeta"),
    functionSource("persistBookmarks"),
    functionSource("bookmarkCurrentKey"),
    functionSource("currentBookmarks"),
    functionSource("bookmarkAddedAt"),
    functionSource("bookmarkLatestAddedAt"),
    functionSource("bookmarkTimesNewestFirst"),
    functionSource("bookmarkSortedKeysNewestFirst"),
    functionSource("saveBookmarks"),
    functionSource("removeBookmarkForKey"),
    "reconcileAllBookmarkMeta();",
  ].join("\n"), context);

  // Legacy un-timestamped entries ignore playback history time and keep reverse insertion order
  assert.deepEqual([...context.bookmarkSortedKeysNewestFirst()], [
    "url:https://example.com/b.mp4",
    "url:https://example.com/a.mp4",
  ]);

  // Legacy un-timestamped entry sorts playback time descending
  assert.deepEqual([...context.bookmarkTimesNewestFirst("url:https://example.com/a.mp4")], [80, 10]);

  // Adding bookmarks to video Z puts Z above legacy A, and newest-added timestamp is first even if earlier in video
  context.posCurrentKey = "url:https://example.com/z.mp4";
  context.saveBookmarks([300]);
  context.saveBookmarks([120, 300]);
  assert.deepEqual([...context.bookmarkTimesNewestFirst("url:https://example.com/z.mp4")], [120, 300]);
  assert.deepEqual([...context.currentBookmarks()], [120, 300]);

  // Adding a new bookmark to video A later moves A above Z
  context.posCurrentKey = "url:https://example.com/a.mp4";
  context.saveBookmarks([10, 45, 80]);
  assert.deepEqual([...context.bookmarkSortedKeysNewestFirst()], [
    "url:https://example.com/a.mp4",
    "url:https://example.com/z.mp4",
    "url:https://example.com/b.mp4",
  ]);
  assert.deepEqual([...context.bookmarkTimesNewestFirst("url:https://example.com/a.mp4")], [45, 80, 10]);
});

test("restoreFromBackupJSON merges history/favorites/playlists and normalizes iOS projection", () => {
  const storage = new Map();
  let savedHistory = [
    { id: "local-1", url: "https://example.com/local-only.mp4", title: "Local Only", position: 30, duration: 100, lastPlayedAt: 1700000000000 },
    { id: "shared-1", url: "https://example.com/shared.mp4", title: "Shared", position: 80, duration: 100, lastPlayedAt: 1700000500000 },
  ];
  const context = {
    Date, Math, Number, Array, Object, Set, Map, JSON, Error, String,
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
    },
    favorites: [{ name: "Local Fav", target: "https://example.com/fav1.mp4", kind: "online", position: 10 }],
    playlists: [{ id: "pl1", name: "VR精选", path: null, entries: [{ file: "https://example.com/p1.mp4", title: "P1", position: 5 }], items: [] }],
    defaultVrProjection: "vr360",
    bookmarkStore: {},
    bookmarkMeta: {},
    lastBookmarkAddedAt: 0,
    bookmarkManagerMask: null,
    backupModalMask: null,
    APPLE_EPOCH_OFFSET: 978307200,
    toAppleSeconds: (ms) => ms / 1000 - 978307200,
    fromAppleOrUnixOrISO: (v) => (typeof v === "number" ? (v + 978307200) * 1000 : Date.now()),
    getPlaybackHistory: () => savedHistory,
    savePlaybackHistory: (h) => { savedHistory = h; },
    saveFavs: () => {},
    renderFavs: () => {},
    entryToItem: (e) => ({ name: e.title, file: e.file }),
    saveTabsState: () => {},
    openPlaylistTab: (name, path, items, entries) => {
      context.playlists.push({ id: "new", name, path, items, entries });
    },
    syncProjectionControls: () => {},
    showSpatialToast: () => {},
    showError: (msg) => { throw new Error(msg); },
  };
  vm.createContext(context);
  vm.runInContext([
    functionSource("restoreFromBackupJSON"),
  ].join("\n"), context);

  const backup = {
    history: [
      { title: "Shared Older", url: "https://example.com/shared.mp4", position: 10, duration: 100, updatedAt: (1700000100000 / 1000) - 978307200 },
      { title: "Remote New", url: "https://example.com/remote.mp4", position: 50, duration: 120, updatedAt: (1700000900000 / 1000) - 978307200 },
    ],
    playlists: [
      { name: "收藏夹", items: [{ file: "https://example.com/fav2.mp4", title: "Fav 2", position: 20 }] },
      { name: "VR精选", items: [{ file: "https://example.com/p2.mp4", title: "P2", position: 15 }] },
    ],
    settings: {
      defaultProjection: { string: "180°" },
    },
  };

  context.restoreFromBackupJSON(JSON.stringify(backup));

  assert.equal(context.defaultVrProjection, "vr180");
  assert.equal(savedHistory.length, 3);
  assert.equal(savedHistory.find((r) => r.url === "https://example.com/shared.mp4").position, 80);
  assert.ok(savedHistory.some((r) => r.url === "https://example.com/local-only.mp4"));
  assert.equal(context.favorites.length, 2);
  assert.equal(context.playlists.length, 1);
  assert.equal(context.playlists[0].entries.length, 2);
});

test("server webdav op upload creates missing parent directories via MKCOL on 404/409", () => {
  const serverSource = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(serverSource, /sendWebdavRequest\("MKCOL", dirUrl\)/);
  assert.match(serverSource, /result\.status === 404 \|\| result\.status === 409/);
});
