import assert from "node:assert/strict";
import { assertFileOperationSuccess } from "../src/grpc/fileOperation.ts";
import { DEFAULT_APP_CONFIG, normalizeAppConfig } from "../src/utils/configSchema.ts";
import { getFileKind, isPlayableMediaFile } from "../src/utils/mediaCatalog.ts";

assert.deepEqual(normalizeAppConfig(null), DEFAULT_APP_CONFIG);
assert.deepEqual(normalizeAppConfig({ grpcBaseUrl: " http://nas:19798 ", apiToken: 42 }), {
  grpcBaseUrl: "http://nas:19798",
  apiToken: "",
  offlineDestPath: "/",
});

assert.equal(isPlayableMediaFile({ name: "episode.webm" }), true);
assert.equal(isPlayableMediaFile({ name: "album.flac" }), true);
assert.equal(isPlayableMediaFile({ name: "folder.mkv", isDirectory: true }), false);
assert.equal(getFileKind({ name: "subtitle.ass" }), "subtitle");

assert.equal(assertFileOperationSuccess({ success: true, errorMessage: "" }, "failed").success, true);
assert.throws(
  () => assertFileOperationSuccess({ success: false, errorMessage: "quota exceeded" }, "failed"),
  /quota exceeded/,
);
assert.throws(() => assertFileOperationSuccess({ success: false, errorMessage: "" }, "fallback"), /fallback/);

console.log("Core behavior checks passed.");
