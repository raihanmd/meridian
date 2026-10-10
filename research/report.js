const CATEGORIES = new Set(["meme", "defi", "rwa", "ai", "infrastructure", "gaming", "stablecoin", "other", "unknown"]);
const CONFIDENCE = new Set(["high", "medium", "low", "unknown"]);

function clean(value, max = 1200) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function publicUrl(value) {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol)) return null;
    if (!url.hostname.includes(".") || /^(localhost|127\.|10\.|192\.168\.|169\.254\.)/i.test(url.hostname)) return null;
    url.username = "";
    url.password = "";
    const href = url.toString();
    return href.length <= 1200 ? href : null;
  } catch { return null; }
}

export function parseReport(text, job) {
  let raw;
  const normalized = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
  try { raw = JSON.parse(normalized); }
  catch { throw new Error("Hermes did not return a JSON report"); }
  if (!raw || typeof raw !== "object" || raw.mint !== job.mint) {
    throw new Error("Research report mint does not match the queued token");
  }
  const sources = Array.isArray(raw.sources) ? raw.sources.slice(0, 30).map((source) => ({
    title: clean(source?.title, 150),
    url: publicUrl(source?.url),
    note: clean(source?.note, 300),
  })).filter((source) => source.url) : [];
  const website = publicUrl(raw.website);
  return {
    mint: job.mint,
    discoveredSymbol: job.symbol,
    projectName: clean(raw.projectName, 120) || "Unknown",
    category: sources.length && CATEGORIES.has(raw.category) ? raw.category : "unknown",
    confidence: sources.length && CONFIDENCE.has(raw.confidence) ? raw.confidence : "unknown",
    summary: clean(raw.summary, 2000) || "No verified project summary found.",
    productStatus: clean(raw.productStatus, 1500) || "Unknown",
    businessModel: clean(raw.businessModel, 1200) || "Unknown",
    tokenUtility: clean(raw.tokenUtility, 1200) || "Unknown",
    tokenRights: clean(raw.tokenRights, 1200) || "Unknown",
    revenueFlows: clean(raw.revenueFlows, 1200) || "Unknown",
    issuanceProceeds: clean(raw.issuanceProceeds, 1200) || "Unknown",
    treasuryRelation: clean(raw.treasuryRelation, 1200) || "Unknown",
    backingRedemption: clean(raw.backingRedemption, 1200) || "Unknown",
    website,
    websiteVerified: Boolean(website && raw.websiteVerified === true && sources.some((source) => source.url === website)),
    identityEvidence: clean(raw.identityEvidence, 800) || "No mint-to-project identity evidence supplied.",
    cautions: clean(raw.cautions, 1200),
    sources,
    researchedAt: new Date().toISOString(),
  };
}

export function formatReport(report) {
  const lines = [
    `Riset token: ${report.projectName} (${report.discoveredSymbol || "?"})`,
    `Mint: ${report.mint}`,
    `Diteliti: ${report.researchedAt}`,
    `Kategori: ${report.category} | Keyakinan: ${report.confidence}`,
    `Situs: ${report.website || "Belum ditemukan"}${report.websiteVerified ? " (terverifikasi dalam sumber)" : " (belum terverifikasi)"}`,
    `Ringkasan: ${report.summary}`,
    `Status produk: ${report.productStatus}`,
    `Model bisnis: ${report.businessModel}`,
    `Fungsi token: ${report.tokenUtility}`,
    `Hak pemegang: ${report.tokenRights}`,
    `Arus pendapatan: ${report.revenueFlows}`,
    `Dana penerbitan: ${report.issuanceProceeds}`,
    `Kaitan treasury: ${report.treasuryRelation}`,
    `Backing/penebusan: ${report.backingRedemption}`,
    `Bukti identitas mint: ${report.identityEvidence}`,
    `Catatan: ${report.cautions || "Tidak ada catatan tambahan"}`,
    "Sumber:",
    ...report.sources.map((source, i) => `${i + 1}. ${source.title || "Sumber"}: ${source.url}${source.note ? ` — ${source.note}` : ""}`),
    ...(report.sources.length ? [] : ["Tidak ada sumber yang berhasil diverifikasi."]),
    "Keputusan tetap manual: masukkan mint ke tokenAllowlist hanya setelah Anda meninjau sumbernya.",
  ];
  return lines.join("\n");
}

export function splitTelegram(text, limit = 3900) {
  const parts = [];
  let remaining = text;
  while (remaining.length) {
    if (remaining.length <= limit) { parts.push(remaining); break; }
    let end = remaining.lastIndexOf("\n", limit);
    if (end < limit / 2) end = limit;
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end).replace(/^\n/, "");
  }
  return parts;
}
