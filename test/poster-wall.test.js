"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

/// 从 index.html 里抽取海报墙识别相关的纯函数，单独求值后做断言。
/// 这样测试跑在最真实的实现上，而不是复制一份逻辑。
function loadPosterHelpers() {
  const start = html.indexOf("const POSTER_VIDEO_EXT");
  const endMarker = "        /// 读取 nfo 元数据";
  const end = html.indexOf(endMarker, start);
  assert.ok(start > 0 && end > start, "poster wall helpers must exist in index.html");
  const source = html.slice(start, end);
  const context = { console };
  vm.createContext(context);
  vm.runInContext(`${source}
    this.__api = { stripExt, posterKindOf, posterKeyOf, buildPosterWall, POSTER_VIDEO_EXT };
  `, context);
  return context.__api;
}

const helpers = loadPosterHelpers();
const toUrl = (item) => `https://nas.local${item.href}`;

/// 构造 WebDAV 风格目录条目
function entry(name, { dir = false, size = 1024 } = {}) {
  return { name, href: `/${encodeURIComponent(name)}`, isDir: dir, size };
}

// 用户真实目录结构的文件名（来自 Nas 截图）
const BASE = "二階堂麗 [EBVR-103-C-4K] 淫乱すぎる美人起業家 二階堂麗VR解禁 天井＆地面特化、耳舐め、顔舐め、淫語";

test("poster wall groups one movie's video + poster + thumb + fanart + nfo into a single card", () => {
  const entries = [
    entry(`${BASE} -cd1.mp4`, { size: 3_000_000_000 }),
    entry(`${BASE} -cd2.mp4`, { size: 6_000_000_000 }),
    entry(`${BASE} -cd1-poster.jpg`),
    entry(`${BASE} -cd2-poster.jpg`),
    entry(`${BASE} -cd1-thumb.jpg`),
    entry(`${BASE} -cd2-thumb.jpg`),
    entry(`${BASE} -cd1-fanart.jpg`),
    entry(`${BASE} -cd2-fanart.jpg`),
    entry(`${BASE} -cd1.nfo`),
    entry(`${BASE} -cd2.nfo`),
  ];

  const { movies, folders, others } = helpers.buildPosterWall(entries, toUrl);

  assert.equal(folders.length, 0, "no folders in this directory listing");
  assert.equal(others.length, 0, "all files must be recognised");
  assert.equal(movies.length, 1, "cd1/cd2 + all artwork collapse into ONE movie");

  const movie = movies[0];
  assert.equal(movie.videos.length, 2, "both discs are kept for multi-disc playback");
  assert.match(movie.videos[0].name, /cd1\.mp4$/, "discs sorted numerically");
  assert.match(movie.videos[1].name, /cd2\.mp4$/);
  assert.ok(movie.posterUrl.endsWith("-cd1-poster.jpg"), "poster is preferred over thumb/fanart");
  assert.equal(movie.thumbs.length, 2, "both preview thumbnails are kept");
  assert.ok(movie.fanart.endsWith("-cd1-fanart.jpg"), "fanart recognised");
  assert.ok(movie.nfoUrl.endsWith("-cd1.nfo"), "nfo attached");
  assert.equal(movie.size, 9_000_000_000, "sizes of all discs are summed");
});

test("poster wall keeps distinct movies apart", () => {
  const entries = [
    entry("Movie A-cd1.mp4"),
    entry("Movie A-poster.jpg"),
    entry("Movie B-cd1.mp4"),
    entry("Movie B-poster.jpg"),
  ];
  const { movies } = helpers.buildPosterWall(entries, toUrl);
  assert.equal(movies.length, 2);
  // vm 上下文返回的数组与当前 realm 不同，先展开再比较
  assert.deepEqual([...movies].map((m) => m.title).sort(), ["Movie A", "Movie B"]);
});

test("poster wall recognises subfolders so the user can drill down", () => {
  const entries = [
    entry("behind the scenes", { dir: true }),
    entry("extrafanart", { dir: true }),
    entry("extrafanart_copy", { dir: true }),
  ];
  const { folders, movies } = helpers.buildPosterWall(entries, toUrl);
  assert.equal(movies.length, 0);
  assert.equal(folders.length, 3);
});

test("folder-level poster.jpg is used as fallback cover for cover-less movies", () => {
  const entries = [
    entry("Some Movie.mp4"),
    entry("poster.jpg"),
  ];
  const { movies } = helpers.buildPosterWall(entries, toUrl);
  assert.equal(movies.length, 1);
  assert.ok(movies[0].posterUrl.endsWith("poster.jpg"), "directory poster becomes the fallback");
});

test("unrecognised files are reported separately instead of leaking into the wall", () => {
  const entries = [
    entry("A-cd1.mp4"),
    entry("readme.txt"),
    entry("archive.zip"),
  ];
  const { movies, others } = helpers.buildPosterWall(entries, toUrl);
  assert.equal(movies.length, 1);
  assert.equal(others.length, 2);
});

test("artwork suffixes cover common Kodi/Infuse/VidHub naming variants", () => {
  const cases = {
    "Movie-poster": "poster",
    "Movie_poster": "poster",
    "Movie.poster": "poster",
    "Movie-thumb": "thumb",
    "Movie-fanart": "fanart",
    "Movie-backdrop": "backdrop",
    "poster": "poster",
    "folder": "poster",
    "cover": "poster",
  };
  for (const [input, expected] of Object.entries(cases)) {
    assert.equal(helpers.posterKindOf(input), expected, input);
  }
  assert.equal(helpers.posterKindOf("Movie"), null);
});

test("disc and quality suffixes are stripped so multi-disc sets share one key", () => {
  const same = [
    helpers.posterKeyOf(`${BASE} -cd1`),
    helpers.posterKeyOf(`${BASE} -cd2`),
    helpers.posterKeyOf(`${BASE} -cd1-poster`),
    helpers.posterKeyOf(`${BASE} -cd2-thumb`),
  ];
  assert.equal(new Set(same).size, 1, `expected one key, got ${JSON.stringify(same)}`);
});

test("VR multi-segment video collapses into ONE movie instead of many", () => {
  // 真实 VR 片源：同一部 8K VR 被切成 3 段，每段各有自己的封面与 nfo
  const base = "愛花あゆみ [DSVR-069-C-8K] 顔面特化 不倫スローセックス 8KVR";
  const entries = [
    entry(`${base} -cd1.mp4`, { size: 5_000_000_000 }),
    entry(`${base} -cd2.mp4`, { size: 5_000_000_000 }),
    entry(`${base} -cd3.mp4`, { size: 5_000_000_000 }),
    entry(`${base} -cd1-poster.jpg`),
    entry(`${base} -cd2-poster.jpg`),
    entry(`${base} -cd1-thumb.jpg`),
    entry(`${base} -cd1.nfo`),
  ];
  const { movies } = helpers.buildPosterWall(entries, toUrl);
  assert.equal(movies.length, 1, "3 segments must merge into 1 movie");
  assert.equal(movies[0].videos.length, 3, "all 3 segments kept as playback queue");
  assert.equal(movies[0].size, 15_000_000_000, "sizes summed across segments");
  assert.ok(!/cd\d/.test(movies[0].title), `title must not contain segment suffix: ${movies[0].title}`);
});

test("segment numbering beyond 9 and zero-padded forms still merge", () => {
  const names = [
    "Show -cd01.mp4", "Show -cd02.mp4", "Show -cd08.mp4",
    "Show -seg9.mp4", "Show _10.mp4",
  ];
  const { movies } = helpers.buildPosterWall(names.map((n) => entry(n)), toUrl);
  // cd01/cd02/cd08/seg9 应合并；_10 是纯数字分段也应合并
  assert.equal(movies.length, 1, `expected 1 movie, got ${movies.length}: ${movies.map((m) => m.title)}`);
  assert.equal(movies[0].videos.length, 5);
});
