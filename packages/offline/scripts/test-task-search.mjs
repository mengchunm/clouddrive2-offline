import assert from "node:assert/strict";
import { createTaskSearchText, getTaskSearchKeywords, matchesTaskSearch } from "../src/utils/taskSearch.ts";

const traditionalTask = {
  name: "進擊的巨人 最終季 第 01 話.mkv",
  url: "magnet:?xt=urn:btih:ABCDEF",
  infoHash: "ABCDEF",
};

assert.equal(matchesTaskSearch(traditionalTask, getTaskSearchKeywords("进击 巨人")), true);
assert.equal(matchesTaskSearch(traditionalTask, getTaskSearchKeywords("进击　01")), true);
assert.equal(matchesTaskSearch(traditionalTask, getTaskSearchKeywords("巨人 02")), false);
assert.equal(matchesTaskSearch(traditionalTask, getTaskSearchKeywords("abcdef")), true);
assert.deepEqual(getTaskSearchKeywords("  进击   巨人  "), ["进击", "巨人"]);
assert.equal(
  matchesTaskSearch(
    { ...traditionalTask, searchText: createTaskSearchText(traditionalTask) },
    getTaskSearchKeywords("进击"),
  ),
  true,
);

console.log("Task search checks passed.");
