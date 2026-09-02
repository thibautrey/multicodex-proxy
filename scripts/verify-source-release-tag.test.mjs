import test from "node:test";
import assert from "node:assert/strict";
import { validateRemoteTag } from "./verify-source-release-tag.mjs";
const commit = "a".repeat(40), tagSha = "b".repeat(40);
test("accepts an annotated tag peeled to the exact workflow commit", () => assert.doesNotThrow(() => validateRemoteTag({object:{type:"tag",sha:tagSha}}, {tag:"source-v0.2.1",object:{type:"commit",sha:commit}}, "source-v0.2.1", commit)));
test("rejects a lightweight tag ref", () => assert.throws(() => validateRemoteTag({object:{type:"commit",sha:commit}}, {}, "source-v0.2.1", commit), /annotated tag object/));
test("rejects an annotated tag peeled to another commit", () => assert.throws(() => validateRemoteTag({object:{type:"tag",sha:tagSha}}, {tag:"source-v0.2.1",object:{type:"commit",sha:"c".repeat(40)}}, "source-v0.2.1", commit), /peeled commit mismatch/));
