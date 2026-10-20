const mongoose = require("mongoose");

const MediaAssetSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      immutable: true,
      index: true,
    },
    sessionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AttendanceSession",
      required: true,
      immutable: true,
      index: true,
    },
    purpose: {
      type: String,
      enum: ["SESSION_EVIDENCE"],
      default: "SESSION_EVIDENCE",
      required: true,
      immutable: true,
    },
    objectKey: {
      type: String,
      required: true,
      immutable: true,
      unique: true,
      select: false,
    },
    contentType: {
      type: String,
      enum: ["image/jpeg"],
      default: "image/jpeg",
      required: true,
      immutable: true,
    },
    sizeBytes: {
      type: Number,
      required: true,
      min: 1,
      max: 2 * 1024 * 1024,
      immutable: true,
    },
    sha256: {
      type: String,
      required: true,
      match: /^[a-f0-9]{64}$/,
      immutable: true,
    },
    originalName: {
      type: String,
      maxlength: 160,
      default: "evidence.jpg",
      immutable: true,
    },
    status: {
      type: String,
      enum: ["UPLOADING", "ACTIVE", "DELETE_PENDING", "DELETED"],
      default: "ACTIVE",
      required: true,
      index: true,
    },
    retentionUntil: {
      type: Date,
      required: true,
      index: true,
    },
    deleteRequestedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

MediaAssetSchema.index({ status: 1, retentionUntil: 1 });

module.exports = mongoose.model("MediaAsset", MediaAssetSchema);
