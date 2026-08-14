import assert from "node:assert/strict";
import { mapCloudPathToLocal } from "../src/localMount.ts";

const windowsDriveMount = {
  mountPoint: "Z:",
  sourceDir: "/115open",
  localMount: false,
  isMounted: true,
};

const fileMatch = mapCloudPathToLocal("/115open/云下载/电影/test.mkv", false, [windowsDriveMount]);
assert.equal(fileMatch?.localTarget, "Z:\\云下载\\电影\\test.mkv");
assert.equal(fileMatch?.localDirectory, "Z:\\云下载\\电影");

const directoryMatch = mapCloudPathToLocal("/115open/云下载/剧集", true, [windowsDriveMount]);
assert.equal(directoryMatch?.localTarget, "Z:\\云下载\\剧集");
assert.equal(directoryMatch?.localDirectory, "Z:\\云下载\\剧集");

const unmounted = mapCloudPathToLocal("/115open/云下载/test.mkv", false, [{ ...windowsDriveMount, isMounted: false }]);
assert.equal(unmounted, undefined);

const nestedMount = mapCloudPathToLocal("/115open/云下载/test.mkv", false, [
  windowsDriveMount,
  {
    mountPoint: "Y:",
    sourceDir: "/115open/云下载",
    localMount: false,
    isMounted: true,
  },
]);
assert.equal(nestedMount?.localTarget, "Y:\\test.mkv");

console.log("Local mount path mapping checks passed.");
