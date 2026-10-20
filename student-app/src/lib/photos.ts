import * as FileSystem from "expo-file-system/legacy";

export async function deleteTemporaryPhotos(uris: string[]) {
  await Promise.all(
    uris.map(async (uri) => {
      try {
        if (uri.startsWith(FileSystem.cacheDirectory || "file://")) {
          await FileSystem.deleteAsync(uri, { idempotent: true });
        }
      } catch {
        // Cache cleanup is best-effort; never log a photo URI.
      }
    }),
  );
}
