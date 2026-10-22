const crypto = require("node:crypto");
const path = require("node:path");

const MediaAsset = require("../../models/MediaAsset.model");
const AttendanceSession = require("../../models/AttendanceSession.model");
const AuditEvent = require("../../models/AuditEvent.model");
const AppError = require("../../utils/AppError");
const storage = require("../../infrastructure/storage/PrivateObjectStorage");

function retentionDays() {
  const configured = Number.parseInt(process.env.MEDIA_RETENTION_DAYS || "30", 10);
  return Number.isInteger(configured) ? Math.max(1, Math.min(configured, 365)) : 30;
}

function safeOriginalName(value) {
  const name = path.basename(String(value || "evidence.jpg"))
    .replace(/[\u0000-\u001f\u007f]/g, "_")
    .replace(/[\\/]/g, "_")
    .trim()
    .slice(0, 160);
  return name || "evidence.jpg";
}

function publicMedia(asset) {
  return {
    id: String(asset._id),
    sessionId: String(asset.sessionId),
    purpose: asset.purpose,
    contentType: asset.contentType,
    sizeBytes: asset.sizeBytes,
    sha256: asset.sha256,
    status: asset.status,
    retentionUntil: asset.retentionUntil,
    createdAt: asset.createdAt,
    deletedAt: asset.deletedAt || null,
  };
}

async function findAccessibleSession({ sessionId, actorId, role }) {
  const filter = { sessionId: String(sessionId) };
  if (role === "Lecturer") filter.lecturerId = actorId;
  const session = await AttendanceSession.findOne(filter).select("_id sessionId lecturerId").lean();
  if (!session) throw new AppError("Attendance session not found or access denied", 404);
  return session;
}

exports.uploadSessionEvidence = async ({
  actorId,
  role,
  sessionId,
  imageBuffer,
  contentType,
  originalName,
}) => {
  if (!Buffer.isBuffer(imageBuffer) || imageBuffer.length < 1 || imageBuffer.length > 2 * 1024 * 1024) {
    throw new AppError("Evidence image is empty or exceeds the size limit", 413);
  }
  if (contentType !== "image/jpeg") {
    throw new AppError("Evidence must be normalized to JPEG before storage", 415);
  }

  const session = await findAccessibleSession({ sessionId, actorId, role });
  const objectKey = "evidence/" + String(actorId) + "/" + crypto.randomUUID() + ".jpg";
  const sha256 = crypto.createHash("sha256").update(imageBuffer).digest("hex");
  const retentionUntil = new Date(Date.now() + retentionDays() * 24 * 60 * 60 * 1000);

  // Persist the upload intent before contacting object storage. If the process
  // crashes after the PUT, the sweeper still knows which key must be cleaned up.
  let asset = await MediaAsset.create({
    ownerId: actorId,
    sessionId: session._id,
    purpose: "SESSION_EVIDENCE",
    objectKey,
    contentType,
    sizeBytes: imageBuffer.length,
    sha256,
    originalName: safeOriginalName(originalName),
    retentionUntil,
    status: "UPLOADING",
  });

  try {
    await storage.putObject({ key: objectKey, body: imageBuffer, contentType });
    const activated = await MediaAsset.updateOne(
      { _id: asset._id, status: "UPLOADING" },
      { $set: { status: "ACTIVE" } },
    );
    if (activated.modifiedCount !== 1) {
      throw new AppError("Could not activate the retained media record", 503);
    }
    asset = await MediaAsset.findById(asset._id).lean();
  } catch (error) {
    // Retain a discoverable cleanup job; the bounded sweeper retries DELETE,
    // treating an already-missing object as success.
    try {
      await MediaAsset.updateOne(
        { _id: asset._id, status: "UPLOADING" },
        { $set: { status: "DELETE_PENDING", deleteRequestedAt: new Date() } },
      );
    } catch (cleanupError) {
      console.error("Media upload cleanup state could not be saved", {
        assetId: String(asset._id),
        errorName: cleanupError?.name || "Error",
      });
    }
    throw error;
  }

  try {
    await AuditEvent.create({
      event: "MEDIA_EVIDENCE_UPLOADED",
      userId: actorId,
      sessionId: session._id,
      metadata: {
        assetId: String(asset._id),
        sizeBytes: asset.sizeBytes,
        contentType: asset.contentType,
        sha256: asset.sha256,
        retentionUntil: asset.retentionUntil,
      },
    });
  } catch (error) {
    // Keep the already stored asset discoverable if audit persistence is unavailable.
    console.error("Media upload audit event failed", {
      assetId: String(asset._id),
      errorName: error?.name || "Error",
    });
  }

  return publicMedia(asset);
};

exports.listSessionEvidence = async ({ sessionId, actorId, role }) => {
  const session = await findAccessibleSession({ sessionId, actorId, role });
  const assets = await MediaAsset.find({
    sessionId: session._id,
    status: "ACTIVE",
    retentionUntil: { $gt: new Date() },
  })
    .select("ownerId sessionId purpose contentType sizeBytes sha256 status retentionUntil createdAt deletedAt")
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  return { data: assets.map(publicMedia) };
};

async function loadOwnedAsset({ assetId, actorId, role }) {
  if (!/^[a-f\d]{24}$/i.test(String(assetId || ""))) {
    throw new AppError("Media asset not found", 404);
  }

  const asset = await MediaAsset.findById(assetId).select("+objectKey").lean();
  if (!asset) throw new AppError("Media asset not found", 404);

  let allowed = role === "Admin" || String(asset.ownerId) === String(actorId);
  if (!allowed && role === "Lecturer") {
    allowed = Boolean(await AttendanceSession.exists({
      _id: asset.sessionId,
      lecturerId: actorId,
    }));
  }
  if (!allowed) throw new AppError("Media asset not found", 404);
  return asset;
}


async function claimMediaDeletion(asset) {
  if (asset.status === "DELETED") {
    return { alreadyDeleted: true, deletedAt: asset.deletedAt || null };
  }
  if (asset.status === "DELETE_PENDING") {
    return { alreadyDeleted: false, alreadyPending: true };
  }
  if (!["ACTIVE", "UPLOADING"].includes(asset.status)) {
    throw new AppError("Media asset cannot be deleted in its current state", 409);
  }

  const claimed = await MediaAsset.updateOne(
    { _id: asset._id, status: asset.status },
    { $set: { status: "DELETE_PENDING", deleteRequestedAt: new Date() } },
  );
  if (claimed.matchedCount === 1 && claimed.modifiedCount === 1) {
    return { alreadyDeleted: false, alreadyPending: false };
  }

  // Another request may have claimed or completed deletion after our read.
  const current = await MediaAsset.findById(asset._id).select("status deletedAt").lean();
  if (current?.status === "DELETED") {
    return { alreadyDeleted: true, deletedAt: current.deletedAt || null };
  }
  if (current?.status === "DELETE_PENDING") {
    return { alreadyDeleted: false, alreadyPending: true };
  }
  throw new AppError("Media asset state changed during deletion; retry the request", 409);
}

async function finalizeMediaDeletion(assetId, deletedAt) {
  const finalized = await MediaAsset.updateOne(
    { _id: assetId, status: "DELETE_PENDING" },
    { $set: { status: "DELETED", deletedAt } },
  );
  if (finalized.matchedCount === 1 && finalized.modifiedCount === 1) {
    return { alreadyDeleted: false, deletedAt };
  }

  // Do not report permanent deletion unless MongoDB confirms the terminal state.
  const current = await MediaAsset.findById(assetId).select("status deletedAt").lean();
  if (current?.status === "DELETED") {
    return { alreadyDeleted: true, deletedAt: current.deletedAt || deletedAt };
  }
  throw new AppError(
    "Media object removal could not be finalized in metadata; cleanup remains pending",
    503,
  );
}

exports.createDownloadUrl = async ({ assetId, actorId, role }) => {
  const asset = await loadOwnedAsset({ assetId, actorId, role });
  if (
    asset.status !== "ACTIVE" ||
    !asset.retentionUntil ||
    new Date(asset.retentionUntil).getTime() <= Date.now()
  ) {
    throw new AppError("Media asset is expired or being deleted", 410);
  }

  const configured = Number.parseInt(process.env.MEDIA_URL_TTL_SECONDS || "60", 10);
  const expiresInSeconds = Number.isInteger(configured)
    ? Math.max(1, Math.min(configured, 300))
    : 60;
  const url = await storage.createDownloadUrl({
    key: asset.objectKey,
    expiresInSeconds,
  });

  // Signing and deletion can race. Recheck persisted state before returning a
  // URL so a concurrent request cannot receive a fresh link after deletion starts.
  const stillActive = await MediaAsset.findOne({
    _id: asset._id,
    status: "ACTIVE",
    retentionUntil: { $gt: new Date() },
  }).select("_id").lean();

  if (!stillActive) {
    throw new AppError("Media asset is expired or being deleted", 410);
  }

  return {
    id: String(asset._id),
    url,
    expiresInSeconds,
    contentType: asset.contentType,
    sizeBytes: asset.sizeBytes,
    retentionUntil: asset.retentionUntil,
  };
};

exports.deleteMediaAsset = async ({ assetId, actorId, role }) => {
  const asset = await loadOwnedAsset({ assetId, actorId, role });
  const claim = await claimMediaDeletion(asset);
  if (claim.alreadyDeleted) {
    return {
      id: String(asset._id),
      status: "DELETED",
      deletedAt: claim.deletedAt,
    };
  }

  // A DELETE_PENDING asset is safe to retry; ACTIVE/UPLOADING must be claimed.
  await AuditEvent.create({
    event: "MEDIA_DELETE_REQUESTED",
    userId: actorId,
    sessionId: asset.sessionId,
    metadata: { assetId: String(asset._id), reason: "OWNER_REQUEST" },
  });

  // If storage or database finalization fails, leave DELETE_PENDING for retry.
  await storage.deleteObject({ key: asset.objectKey });
  const finalized = await finalizeMediaDeletion(asset._id, new Date());

  if (!finalized.alreadyDeleted) {
    try {
      await AuditEvent.create({
        event: "MEDIA_DELETED",
        userId: actorId,
        sessionId: asset.sessionId,
        metadata: { assetId: String(asset._id), deletedAt: finalized.deletedAt },
      });
    } catch (error) {
      console.error("Media deletion audit event failed", {
        assetId: String(asset._id),
        errorName: error?.name || "Error",
      });
    }
  }

  return {
    id: String(asset._id),
    status: "DELETED",
    deletedAt: finalized.deletedAt,
  };
};

exports.sweepExpiredMediaAssets = async ({ limit = 25 } = {}) => {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || 25, 100));
  const now = new Date();
  const staleUploadBefore = new Date(now.getTime() - 10 * 60 * 1000);
  const candidates = await MediaAsset.find({
    status: { $in: ["ACTIVE", "DELETE_PENDING", "UPLOADING"] },
    $or: [
      { retentionUntil: { $lte: now } },
      { status: "DELETE_PENDING" },
      { status: "UPLOADING", createdAt: { $lte: staleUploadBefore } },
    ],
  })
    .select("+objectKey ownerId sessionId status retentionUntil")
    .sort({ retentionUntil: 1 })
    .limit(boundedLimit)
    .lean();

  const result = { scanned: candidates.length, deleted: 0, failed: 0 };
  for (const asset of candidates) {
    try {
      if (asset.status !== "DELETE_PENDING") {
        const claimFilter = { _id: asset._id, status: asset.status };
        if (asset.status === "ACTIVE") claimFilter.retentionUntil = { $lte: now };
        if (asset.status === "UPLOADING") claimFilter.createdAt = { $lte: staleUploadBefore };
        const claimed = await MediaAsset.updateOne(
          claimFilter,
          { $set: { status: "DELETE_PENDING", deleteRequestedAt: now } },
        );
        if (claimed.modifiedCount !== 1) continue;
      }

      await storage.deleteObject({ key: asset.objectKey });
      const finalized = await finalizeMediaDeletion(asset._id, new Date());
      if (!finalized.alreadyDeleted) {
        try {
          await AuditEvent.create({
            event: "MEDIA_DELETED",
            ...(asset.ownerId ? { userId: asset.ownerId } : {}),
            sessionId: asset.sessionId,
            metadata: {
              assetId: String(asset._id),
              reason: "RETENTION_EXPIRED",
              deletedAt: finalized.deletedAt,
            },
          });
        } catch (auditError) {
          console.error("Expired media cleanup audit event failed", {
            assetId: String(asset._id),
            errorName: auditError?.name || "Error",
          });
        }
      }
      result.deleted += 1;
    } catch (error) {
      result.failed += 1;
      console.error("Expired media cleanup failed", {
        assetId: String(asset._id),
        errorName: error?.name || "Error",
      });
    }
  }

  return result;
};
