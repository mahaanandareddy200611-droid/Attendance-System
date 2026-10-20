const asyncHandler = require("../../middlewares/asyncHandler");
const AppError = require("../../utils/AppError");
const mediaService = require("./MediaService");

exports.uploadEvidence = asyncHandler(async (req, res) => {
  if (!req.file) throw new AppError("Evidence image is required", 400);
  const asset = await mediaService.uploadSessionEvidence({
    actorId: req.user.id,
    role: req.user.role,
    sessionId: req.body.sessionId,
    imageBuffer: req.file.buffer,
    contentType: req.file.mimetype,
    originalName: req.file.originalname,
  });
  return res.status(201).json({
    success: true,
    message: "Evidence uploaded to private storage",
    data: asset,
    requestId: req.id,
  });
});

exports.getDownloadUrl = asyncHandler(async (req, res) => {
  const data = await mediaService.createDownloadUrl({
    assetId: req.params.assetId,
    actorId: req.user.id,
    role: req.user.role,
  });
  return res.status(200).json({ success: true, data, requestId: req.id });
});

exports.deleteMedia = asyncHandler(async (req, res) => {
  const data = await mediaService.deleteMediaAsset({
    assetId: req.params.assetId,
    actorId: req.user.id,
    role: req.user.role,
  });
  return res.status(200).json({
    success: true,
    message: "Media deletion completed",
    data,
    requestId: req.id,
  });
});
