function startsWithSpreadsheetFormula(value) {
  // Excel may ignore leading ASCII controls/whitespace before a formula prefix.
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x20 || code === 0xfeff || code === 0x00a0) continue;
    return ["=", "+", "@", "-"].includes(value[index]);
  }
  return false;
}

export function escapeCsvCell(value) {
  let text = String(value == null ? "" : value);
  if (startsWithSpreadsheetFormula(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

export function createCsv(headers, rows) {
  if (!Array.isArray(headers) || !Array.isArray(rows)) {
    throw new TypeError("CSV headers and rows must be arrays.");
  }
  const matrix = [headers, ...rows];
  return (
    "\uFEFF" +
    matrix
      .map((row) => {
        if (!Array.isArray(row)) throw new TypeError("Each CSV row must be an array.");
        return row.map(escapeCsvCell).join(",");
      })
      .join("\r\n")
  );
}

export function downloadCsv(filename, csvText) {
  const safeFilename = String(filename || "report.csv").replace(/[^a-z0-9._-]/gi, "-");
  const blobUrl = URL.createObjectURL(new Blob([csvText], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = blobUrl;
  anchor.download = safeFilename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}
