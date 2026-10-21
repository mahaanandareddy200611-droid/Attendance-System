"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const MediaAsset = require("../src/models/MediaAsset.model");
const AuditEvent = require("../src/models/AuditEvent.model");
const storage = require("../src/infrastructure/storage/PrivateObjectStorage");
const mediaService = require("../src/modules/Media/MediaService");

const ASSET_ID = "507f1f77bcf86cd799439013";
const OWNER_ID = "507f1f77bcf86cd799439012";
const SESSION_ID = "507f1f77bcf86cd799439011";

function query(value) {
  return {
    select() { return this; },
    lean: async () => value,
  };
}

function mediaDoc(status = "ACTIVE") {
  return {
    _id: ASSET_ID,
    ownerId: OWNER_ID,
    sessionId: SESSION_ID,
    objectKey: "evidence/owner/canary.jpg",
    purpose: "SESSION_EVIDENCE",
    contentType: "image/jpeg",
    sizeBytes: 16,
    sha256: "a".repeat(64),
    status,
    retentionUntil: new Date(Date.now() + 60_000),
    deletedAt: null,
  };
}

function installCommonMocks(t, state, { failFinalization = false } = {}) {
  t.mock.method(MediaAsset, "findById", () => query(state.doc));
  t.mock.method(MediaAsset, "updateOne", async (filter, update) => {
    if (!state.doc || String(filter._id) !== String(state.doc._id)) {
      return { matchedCount: 0, modifiedCount: 0 };
    }
    if (filter.status && state.doc.status !== filter.status) {
      return { matchedCount: 0, modifiedCount: 0 };
    }
    if (failFinalization && update.$set?.status === "DELETED") {
      return { matchedCount: 0, modifiedCount: 0 };
    }
    Object.assign(state.doc, update.$set);
    return { matchedCount: 1, modifiedCount: 1 };
  });
  t.mock.method(AuditEvent, "create", async (event) => {
    state.auditEvents.push(event);
    return event;
  });
  t.mock.method(storage, "deleteObject", async () => {
    state.deletes += 1;
  });
}

test("deletion claims an UPLOADING record and confirms DELETED state only after metadata persists", async (t) => {
  const state = { doc: mediaDoc("UPLOADING"), deletes: 0, auditEvents: [] };
  installCommonMocks(t, state);

  const result = await mediaService.deleteMediaAsset({
    assetId: ASSET_ID,
    actorId: OWNER_ID,
    role: "Admin",
  });

  assert.equal(result.status, "DELETED");
  assert.equal(state.doc.status, "DELETED");
  assert.equal(state.deletes, 1);
});

test("deletion fails closed when object removal succeeds but terminal metadata update fails", async (t) => {
  const state = { doc: mediaDoc("ACTIVE"), deletes: 0, auditEvents: [] };
  installCommonMocks(t, state, { failFinalization: true });

  await assert.rejects(
    mediaService.deleteMediaAsset({
      assetId: ASSET_ID,
      actorId: OWNER_ID,
      role: "Admin",
    }),
    (error) => error.statusCode === 503 && /could not be finalized in metadata/i.test(error.message),
  );

  assert.equal(state.deletes, 1);
  assert.equal(state.doc.status, "DELETE_PENDING");
});

test("download URL is withheld if deletion begins while URL signing is in progress", async (t) => {
  const state = { doc: mediaDoc("ACTIVE"), deletes: 0, auditEvents: [] };
  t.mock.method(MediaAsset, "findById", () => query(state.doc));
  t.mock.method(MediaAsset, "findOne", (filter) => query(
    state.doc.status === filter.status &&
    new Date(state.doc.retentionUntil) > filter.retentionUntil.$gt
      ? { _id: state.doc._id }
      : null
  ));
  t.mock.method(storage, "createDownloadUrl", async () => {
    state.doc.status = "DELETE_PENDING";
    return "https://private.example/signed";
  });

  await assert.rejects(
    mediaService.createDownloadUrl({
      assetId: ASSET_ID,
      actorId: OWNER_ID,
      role: "Admin",
    }),
    (error) => error.statusCode === 410,
  );
});
