import assert from "node:assert/strict";
import {
	chineseToNumber,
	extractEpisodeNumber,
	extractKeyword,
	findBestEpisode,
} from "../src/utils/danmuMatch.ts";
import { getMediaIdentity, isMkvMedia } from "../src/utils/mediaIdentity.ts";

assert.equal(isMkvMedia("Episode 01.mkv", "https://host/download?id=1"), true);
assert.equal(isMkvMedia(undefined, "https://host/video.mkv?token=old"), true);
assert.equal(isMkvMedia("Episode 01.mp4", "https://host/video.mkv"), false);

assert.equal(
	getMediaIdentity(
		"https://host/download?token=old",
		"/Anime/Episode 01.mkv",
		"Episode 01.mkv",
	),
	"path:/Anime/Episode 01.mkv",
);
assert.equal(
	getMediaIdentity("https://host/download?token=old#fragment"),
	"url:https://host/download",
);

assert.equal(chineseToNumber("二十一"), 21);
assert.equal(extractEpisodeNumber("某番 S02E08 1080p.mkv"), 8);
assert.match(
	extractKeyword("[LoliHouse] 达尔文事变 / Darwin Jihen - 10 [1080p].mkv"),
	/达尔文事变/,
);
assert.deepEqual(
	findBestEpisode("某番 第十二集.mkv", [
		{
			animeId: 1,
			animeTitle: "某番",
			type: "tvseries",
			typeDescription: "TV",
			episodes: [
				{ episodeId: 11, episodeTitle: "第2集" },
				{ episodeId: 12, episodeTitle: "第十二集" },
			],
		},
	]),
	{ episodeId: 12, animeTitle: "某番", episodeTitle: "第十二集" },
);

console.log("Player utility checks passed.");
