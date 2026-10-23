"use client";

import { useMemo, useState } from "react";
import { fillBulkWorkbook, inspectBulkWorkbook } from "./bulk-workbook";
import GenerationOverlay from "./GenerationOverlay";
import type { BulkAnalysis, BulkAssignment, BulkProduct, Picture } from "./library-types";

type ReviewProduct = BulkProduct & { sameSector: Picture[]; otherSectors: Picture[] };
type Choice = { kind: "use"; image: Picture } | { kind: "review"; image: Picture } | { kind: "skip"; image?: Picture };
type ReviewFilter = "all" | "other-sector" | "no-image" | "in-sector" | "needs-choice" | "selected" | "skipped";
type ApiResult = { images?: Picture[]; nextCursor?: string | null; error?: string };
type Props = {
  apiBase: string;
  uploadPassword: string;
  sectors: string[];
  onClose: () => void;
  onImagesAdded: (images: Picture[]) => void;
  notify: (message: string) => void;
};

function endpoint(base: string, path: string): string { return base.replace(/\/$/, "") + path; }
const ALL_SECTORS = "All sectors";
function uniquePictures(pictures: Picture[]): Picture[] {
  const unique = new Map<string, Picture>();
  for (const picture of pictures) {
    const key = picture.publicId || picture.url;
    const previous = unique.get(key);
    if (!previous || previous.createdAt < picture.createdAt) unique.set(key, picture);
  }
  return [...unique.values()];
}
function normalizedPlu(value: string): string { return value.trim().toLocaleUpperCase(); }
function normalizedSearchText(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();
}
function searchPicturesByKeywords(pictures: Picture[], query: string): Picture[] {
  const normalizedQuery = normalizedSearchText(query).trim();
  const keywords = [...new Set(normalizedQuery.split(/[^a-z0-9]+/).filter(word => word.length > 1 || /^\d+$/.test(word)))];
  if (keywords.length === 0) return [];
  return pictures.map(image => {
    const name = normalizedSearchText(image.name + " " + image.filename);
    const searchable = normalizedSearchText([image.name, image.plu, image.sector, image.filename].join(" "));
    const matched = keywords.filter(word => searchable.includes(word));
    if (matched.length === 0) return null;
    const nameMatches = keywords.filter(word => name.includes(word)).length;
    const phraseMatch = name.includes(normalizedQuery) ? 1 : 0;
    return { image, score: matched.length * 10 + nameMatches * 4 + phraseMatch * 6 };
  }).filter((result): result is { image: Picture; score: number } => result !== null)
    .sort((a, b) => b.score - a.score || b.image.createdAt.localeCompare(a.image.createdAt))
    .slice(0, 12)
    .map(result => result.image);
}

export default function BulkUploadDialog({ apiBase, uploadPassword, sectors, onClose, onImagesAdded, notify }: Props) {
  const [sector, setSector] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<BulkAnalysis | null>(null);
  const [items, setItems] = useState<ReviewProduct[]>([]);
  const [catalogPictures, setCatalogPictures] = useState<Picture[]>([]);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [optionsOpen, setOptionsOpen] = useState<Record<string, boolean>>({});
  const [keywordSearchOpen, setKeywordSearchOpen] = useState<Record<string, boolean>>({});
  const [keywordDrafts, setKeywordDrafts] = useState<Record<string, string>>({});
  const [keywordSearches, setKeywordSearches] = useState<Record<string, string>>({});
  const [generationDescriptions, setGenerationDescriptions] = useState<Record<string, string>>({});
  const [bulkUploadFiles, setBulkUploadFiles] = useState<Record<string, File>>({});
  const [bulkUploadCleanup, setBulkUploadCleanup] = useState<Record<string, boolean>>({});
  const [newImageSectors, setNewImageSectors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [generatingAll, setGeneratingAll] = useState(false);
  const [generatingIds, setGeneratingIds] = useState<string[]>([]);
  const [uploadingIds, setUploadingIds] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ current: number; total: number; name: string } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const allSectorsSelected = sector === ALL_SECTORS;

  const assignments = useMemo<BulkAssignment[]>(() => items.flatMap(item => {
    const choice = choices[item.id];
    return choice?.kind === "use" ? [{ productId: item.id, url: choice.image.url }] : [];
  }), [items, choices]);
  const rowsToFill = useMemo(() => items.reduce((count, item) =>
    count + (choices[item.id]?.kind === "use" ? item.rows.length : 0), 0), [items, choices]);
  const unresolvedCount = items.filter(item => {
    const choice = choices[item.id];
    return choice?.kind !== "use" && choice?.kind !== "skip";
  }).length;
  const filterCounts = {
    all: items.length,
    otherSector: items.filter(item => item.otherSectors.length > 0).length,
    noImage: items.filter(item => item.sameSector.length === 0 && item.otherSectors.length === 0 && choices[item.id]?.kind !== "use").length,
    inSector: items.filter(item => item.sameSector.length > 0).length,
    needsChoice: unresolvedCount,
    selected: items.filter(item => choices[item.id]?.kind === "use").length,
    skipped: items.filter(item => choices[item.id]?.kind === "skip").length
  };
  const filteredItems = useMemo(() => items.filter(item => {
    const choice = choices[item.id];
    switch (reviewFilter) {
      case "other-sector": return item.otherSectors.length > 0;
      case "no-image": return item.sameSector.length === 0 && item.otherSectors.length === 0 && choice?.kind !== "use";
      case "in-sector": return item.sameSector.length > 0;
      case "needs-choice": return choice?.kind !== "use" && choice?.kind !== "skip";
      case "selected": return choice?.kind === "use";
      case "skipped": return choice?.kind === "skip";
      default: return true;
    }
  }), [items, choices, reviewFilter]);
  const missingToGenerate = items.filter(item =>
    item.sameSector.length === 0 && item.otherSectors.length === 0 &&
    choices[item.id]?.kind !== "skip" && choices[item.id]?.kind !== "use" && item.canGenerate
  );
  const activeGeneration = items.find(item => generatingIds.includes(item.id));
  const activeUpload = items.find(item => uploadingIds.includes(item.id));

  function destinationSector(item: ReviewProduct): string {
    return allSectorsSelected ? newImageSectors[item.id] || "" : sector;
  }

  function renderDestinationSector(item: ReviewProduct, busy: boolean) {
    if (!allSectorsSelected) return null;
    return <div className="bulk-destination-sector">
      <label className="form-label" htmlFor={`new-image-sector-${item.id}`}>Save new image to sector</label>
      <select id={`new-image-sector-${item.id}`} className="field" value={newImageSectors[item.id] || ""} disabled={Boolean(generatingAll || busy)} onChange={event => setNewImageSectors(current => ({ ...current, [item.id]: event.target.value }))}>
        <option value="">Choose a sector</option>
        {sectors.map(value => <option key={value} value={value}>{value}</option>)}
      </select>
    </div>;
  }

  const canGenerateAll = !allSectorsSelected || missingToGenerate.every(item => Boolean(newImageSectors[item.id]));

  function changeChoice(item: ReviewProduct, choice: Choice) {
    setChoices(current => ({ ...current, [item.id]: choice }));
    setOptionsOpen(current => ({ ...current, [item.id]: false }));
    setKeywordSearchOpen(current => ({ ...current, [item.id]: false }));
    setItemErrors(current => { const next = { ...current }; delete next[item.id]; return next; });
  }

  function toggleAssignment(item: ReviewProduct, image: Picture, assigned: boolean) {
    setChoices(current => ({
      ...current,
      [item.id]: assigned ? { kind: "use", image } : { kind: "skip", image }
    }));
    setItemErrors(current => { const next = { ...current }; delete next[item.id]; return next; });
  }

  function runKeywordSearch(item: ReviewProduct) {
    const query = (keywordDrafts[item.id] ?? item.name).trim();
    if (query.length < 2) return;
    setKeywordSearches(current => ({ ...current, [item.id]: query }));
  }

  function renderKeywordSearch(item: ReviewProduct, busy: boolean) {
    const open = Boolean(keywordSearchOpen[item.id]);
    const draft = keywordDrafts[item.id] ?? item.name;
    const query = keywordSearches[item.id] || "";
    const results = open && query ? searchPicturesByKeywords(catalogPictures, query) : [];
    return <div className="bulk-keyword-search">
      <button type="button" className="link-button" aria-expanded={open} disabled={busy} onClick={() => setKeywordSearchOpen(current => ({ ...current, [item.id]: !current[item.id] }))}>
        {open ? "Hide catalogue search" : "Search catalogue by keywords"}
      </button>
      {open && <>
        <label className="form-label" htmlFor={`bulk-keyword-${item.id}`}>Search by item name, keywords or PLU</label>
        <div className="bulk-keyword-search-form">
          <input id={`bulk-keyword-${item.id}`} className="field" type="search" value={draft} placeholder="For example, chicken wrap" disabled={Boolean(generatingAll || busy)} onChange={event => {
            const value = event.target.value;
            setKeywordDrafts(current => ({ ...current, [item.id]: value }));
            setKeywordSearches(current => { const next = { ...current }; delete next[item.id]; return next; });
          }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); runKeywordSearch(item); } }} />
          <button type="button" className="secondary-button" disabled={Boolean(generatingAll || busy) || draft.trim().length < 2} onClick={() => runKeywordSearch(item)}>Search</button>
        </div>
        <p className="bulk-keyword-hint">Searches names and PLUs across all sectors. Choose a result to preview it and use its URL for workbook PLU {item.plu}.</p>
        {query && results.length > 0 && <div className="bulk-candidates" aria-label={`Catalogue results for ${query}`}>
          {results.map(image => <button type="button" className="bulk-candidate" key={image.publicId || image.url} disabled={busy} onClick={() => changeChoice(item, { kind: "use", image })}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={image.url} alt={`Preview of ${image.name}`} loading="lazy" />
            <span><b>{image.name}</b><small>{image.sector} · PLU {image.plu}</small></span>
            <span className="candidate-use">Use URL</span>
          </button>)}
        </div>}
        {query && results.length === 0 && <p className="bulk-keyword-empty">No catalogue images matched those keywords. Try fewer or different terms.</p>}
      </>}
    </div>;
  }

  async function loadFullCatalog(): Promise<Picture[]> {
    const pictures: Picture[] = [];
    let cursor: string | null = null;
    const cursors = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const url = new URL(endpoint(apiBase, "/api/images"));
      url.searchParams.set("bulk", "1");
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await fetch(url.toString(), { cache: "no-store" });
      const data = await response.json() as ApiResult;
      if (!response.ok) throw new Error(data.error || "Could not search the image library.");
      pictures.push(...(data.images || []));
      cursor = data.nextCursor || null;
      if (!cursor) return uniquePictures(pictures);
      if (cursors.has(cursor)) throw new Error("The image catalogue returned a repeated page. Please try again.");
      cursors.add(cursor);
    }
    throw new Error("The catalogue is larger than the bulk search limit. Ask the administrator to extend the lookup range.");
  }

  async function analyze() {
    if (!file || !sector) return;
    setLoading(true); setError(""); setAnalysis(null); setItems([]); setCatalogPictures([]); setChoices({}); setReviewFilter("all"); setOptionsOpen({}); setKeywordSearchOpen({}); setKeywordDrafts({}); setKeywordSearches({}); setItemErrors({}); setBulkUploadFiles({}); setBulkUploadCleanup({}); setNewImageSectors({});
    try {
      const workbook = await inspectBulkWorkbook(file);
      const catalog = await loadFullCatalog();
      setCatalogPictures(catalog);
      const review = workbook.products.map(product => {
        const matches = catalog.filter(image => normalizedPlu(image.plu) === normalizedPlu(product.plu));
        const sameSector = matches.filter(image => allSectorsSelected || image.sector === sector).sort((a, b) => allSectorsSelected ? a.sector.localeCompare(b.sector) || b.createdAt.localeCompare(a.createdAt) : b.createdAt.localeCompare(a.createdAt));
        const otherSectors = allSectorsSelected ? [] : matches.filter(image => image.sector !== sector).sort((a, b) => a.sector.localeCompare(b.sector) || b.createdAt.localeCompare(a.createdAt));
        return { ...product, sameSector, otherSectors };
      });
      const initial: Record<string, Choice> = {};
      for (const item of review) {
        if (item.sameSector.length === 1 && item.otherSectors.length === 0)
          initial[item.id] = { kind: "use", image: item.sameSector[0] };
        else if (item.sameSector.length + item.otherSectors.length === 1)
          initial[item.id] = { kind: "review", image: item.sameSector[0] || item.otherSectors[0] };
      }
      setAnalysis(workbook); setItems(review); setChoices(initial);
      setGenerationDescriptions(Object.fromEntries(review.map(item => [item.id, item.description])));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read this workbook.");
    } finally { setLoading(false); }
  }

  async function generateOne(item: ReviewProduct): Promise<void> {
    if (!item.canGenerate || generatingIds.includes(item.id)) return;
    const imageSector = destinationSector(item);
    if (!imageSector) {
      setItemErrors(current => ({ ...current, [item.id]: "Choose a sector for the new image." }));
      return;
    }
    setGeneratingIds(current => current.includes(item.id) ? current : [...current, item.id]);
    setItemErrors(current => { const next = { ...current }; delete next[item.id]; return next; });
    try {
      const body = new FormData();
      body.append("mode", "generate");
      body.append("name", item.name.slice(0, 80));
      body.append("plu", item.plu);
      body.append("sector", imageSector);
      body.append("description", (generationDescriptions[item.id] || item.description || item.name).slice(0, 1000));
      const response = await fetch(endpoint(apiBase, "/api/images"), {
        method: "POST", headers: { "X-Upload-Password": uploadPassword }, body
      });
      const data = await response.json() as { image?: Picture; error?: string };
      if (!response.ok || !data.image) throw new Error(data.error || "Image generation failed.");
      const picture = data.image;
      setCatalogPictures(current => uniquePictures([picture, ...current]));
      setChoices(current => ({ ...current, [item.id]: { kind: "use", image: picture } }));
      setOptionsOpen(current => ({ ...current, [item.id]: false }));
      onImagesAdded([picture]);
      setItemErrors(current => { const next = { ...current }; delete next[item.id]; return next; });
    } catch (cause) {
      setItemErrors(current => ({ ...current, [item.id]: cause instanceof Error ? cause.message : "Image generation failed." }));
    } finally {
      setGeneratingIds(current => current.filter(id => id !== item.id));
    }
  }

  async function uploadItemImage(item: ReviewProduct): Promise<void> {
    const image = bulkUploadFiles[item.id];
    if (!image || uploadingIds.includes(item.id)) return;
    const imageSector = destinationSector(item);
    if (!imageSector) {
      setItemErrors(current => ({ ...current, [item.id]: "Choose a sector for the uploaded image." }));
      return;
    }
    if (image.size > 8 * 1024 * 1024) {
      setItemErrors(current => ({ ...current, [item.id]: "Choose an image smaller than 8 MB." }));
      return;
    }
    setUploadingIds(current => current.includes(item.id) ? current : [...current, item.id]);
    setItemErrors(current => { const next = { ...current }; delete next[item.id]; return next; });
    try {
      const body = new FormData();
      body.append("mode", "upload");
      body.append("image", image);
      body.append("name", item.name.slice(0, 80));
      body.append("plu", item.plu);
      body.append("sector", imageSector);
      body.append("cleanup", String(Boolean(bulkUploadCleanup[item.id])));
      const response = await fetch(endpoint(apiBase, "/api/images"), {
        method: "POST", headers: { "X-Upload-Password": uploadPassword }, body
      });
      const data = await response.json() as { image?: Picture; error?: string };
      if (!response.ok || !data.image) throw new Error(data.error || "Image upload failed.");
      const picture = data.image;
      setCatalogPictures(current => uniquePictures([picture, ...current]));
      setChoices(current => ({ ...current, [item.id]: { kind: "use", image: picture } }));
      setOptionsOpen(current => ({ ...current, [item.id]: false }));
      setBulkUploadFiles(current => { const next = { ...current }; delete next[item.id]; return next; });
      setBulkUploadCleanup(current => ({ ...current, [item.id]: false }));
      onImagesAdded([picture]);
      setItemErrors(current => { const next = { ...current }; delete next[item.id]; return next; });
    } catch (cause) {
      setItemErrors(current => ({ ...current, [item.id]: cause instanceof Error ? cause.message : "Image upload failed." }));
    } finally {
      setUploadingIds(current => current.filter(id => id !== item.id));
    }
  }

  function renderUploadOption(item: ReviewProduct, busy: boolean) {
    const selectedFile = bulkUploadFiles[item.id];
    const uploading = uploadingIds.includes(item.id);
    const destinationReady = Boolean(destinationSector(item));
    return <div className="bulk-upload-option">
      <label className="form-label" htmlFor={`bulk-upload-${item.id}`}>Or upload an image</label>
      <input id={`bulk-upload-${item.id}`} className="field bulk-upload-file" type="file" accept="image/jpeg,image/png,image/webp" disabled={Boolean(generatingAll || busy)} onChange={event => {
        const selected = event.target.files?.[0];
        setBulkUploadFiles(current => {
          const next = { ...current };
          if (selected) next[item.id] = selected;
          else delete next[item.id];
          return next;
        });
        setItemErrors(current => { const next = { ...current }; delete next[item.id]; return next; });
      }} />
      <p className="bulk-upload-hint">JPG, PNG or WebP · up to 8 MB</p>
      {selectedFile && <p className="bulk-upload-filename">Selected: {selectedFile.name}</p>}
      <label className="bulk-cleanup-choice">
        <input type="checkbox" checked={Boolean(bulkUploadCleanup[item.id])} disabled={!selectedFile || Boolean(generatingAll || busy)} onChange={event => setBulkUploadCleanup(current => ({ ...current, [item.id]: event.target.checked }))} />
        <span><b>Clean up with AI</b><small>Match the shared menu-photo style. AI cleanup is billed to the OpenAI API account.</small></span>
      </label>
      <button type="button" className="primary-button bulk-upload-submit" disabled={!selectedFile || !destinationReady || Boolean(generatingAll || busy)} onClick={() => void uploadItemImage(item)}>
        {uploading ? bulkUploadCleanup[item.id] ? "Cleaning up & uploading…" : "Uploading image…" : !destinationReady ? "Choose a destination sector" : bulkUploadCleanup[item.id] ? "Clean up & upload image" : "Upload image"}
      </button>
    </div>;
  }

  async function generateAllMissing() {
    const targets = [...missingToGenerate];
    if (!targets.length || generatingAll) return;
    if (allSectorsSelected && targets.some(item => !newImageSectors[item.id])) {
      setError("Choose a destination sector for every missing PLU before generating all.");
      return;
    }
    setGeneratingAll(true);
    try {
      for (let index = 0; index < targets.length; index++) {
        const item = targets[index];
        setProgress({ current: index + 1, total: targets.length, name: item.name });
        await generateOne(item);
      }
    } finally { setGeneratingAll(false); setProgress(null); }
  }

  async function downloadWorkbook() {
    if (!file || !analysis || items.length === 0 || downloading) return;
    setDownloading(true); setError("");
    try {
      const blob = await fillBulkWorkbook(file, items, assignments);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = `${file.name.replace(/\.xlsx$/i, "")}_with_image_urls.xlsx`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      notify("Filled workbook downloaded.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create the filled workbook.");
    } finally { setDownloading(false); }
  }

  function close() {
    if (loading || generatingAll || generatingIds.length || uploadingIds.length || downloading) return;
    onClose();
  }

  return (
    <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <section className="modal bulk-modal" role="dialog" aria-modal="true" aria-label="Fill image URLs in a bulk workbook">
        <button type="button" className="modal-close" disabled={loading || generatingAll || downloading || Boolean(generatingIds.length) || Boolean(uploadingIds.length)} onClick={close} aria-label="Close dialog">×</button>
        <div className="section-eyebrow">BULK PORTAL SHEET</div>
        <h2>Fill image URLs</h2>
        <p className="modal-intro">Choose the sector first. We’ll match PLUs in column N and fill blank Image URL cells in column S. Previews stay visible as you review; tick the images to include, then assign all URLs and download the workbook.</p>

        {!analysis ? <>
          <div className="bulk-setup-grid">
            <div>
              <label className="form-label" htmlFor="bulk-sector">Sector <b>*</b></label>
              <select id="bulk-sector" className="field" value={sector} onChange={event => setSector(event.target.value)} disabled={loading}>
                <option value="" disabled>Select a sector</option>
                <option value={ALL_SECTORS}>All sectors · search the full catalogue</option>
                {sectors.map(value => <option key={value} value={value}>{value}</option>)}
              </select>
            </div>
            <div>
              <label className="form-label" htmlFor="bulk-file">Portal workbook <b>*</b></label>
              <input id="bulk-file" className="field bulk-file-input" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={!sector || loading} onChange={event => { setFile(event.target.files?.[0] || null); setError(""); }} />
            </div>
          </div>
          {file && <div className="filename-hint">Selected: {file.name}</div>}
          <p className="style-note">PLU rows without a URL will be matched. Rows with no PLU are ignored. Only unmatched items you choose to generate are sent to the AI service; the full sheet remains on your device.</p>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="modal-actions"><button className="secondary-button" type="button" disabled={loading} onClick={close}>Cancel</button><button className="primary-button" type="button" disabled={!sector || !file || loading} onClick={() => void analyze()}>{loading ? "Reading sheet and searching PLUs…" : "Find image URLs →"}</button></div>
        </> : <>
          <div className="bulk-summary">
            <span><b>{items.length}</b> items to check</span>
            <span><b>{analysis.preservedUrlRows}</b> existing URLs preserved</span>
            <span><b>{analysis.ignoredBlankPluRows}</b> rows without a PLU ignored</span>
          </div>
          <p className="bulk-sheet-note">Sheets checked: {analysis.sheets.join(", ")}. {allSectorsSelected ? <>PLUs are matched across all sectors; choose a destination sector below for any new images.</> : <>Existing images in <b>{sector}</b> are matched automatically when one clear match exists.</>}</p>
          <div className="bulk-filter-bar" role="group" aria-label="Filter workbook items">
            <span className="bulk-filter-label">Show</span>
            <button type="button" className={reviewFilter === "all" ? "bulk-filter active" : "bulk-filter"} aria-pressed={reviewFilter === "all"} onClick={() => setReviewFilter("all")}>All PLUs <b>{filterCounts.all}</b></button>
            {!allSectorsSelected && <button type="button" className={reviewFilter === "other-sector" ? "bulk-filter active" : "bulk-filter"} aria-pressed={reviewFilter === "other-sector"} disabled={filterCounts.otherSector === 0} onClick={() => setReviewFilter("other-sector")}>PLU found in different sector <b>{filterCounts.otherSector}</b></button>}
            <button type="button" className={reviewFilter === "no-image" ? "bulk-filter active" : "bulk-filter"} aria-pressed={reviewFilter === "no-image"} disabled={filterCounts.noImage === 0} onClick={() => setReviewFilter("no-image")}>No image found <b>{filterCounts.noImage}</b></button>
            <button type="button" className={reviewFilter === "in-sector" ? "bulk-filter active" : "bulk-filter"} aria-pressed={reviewFilter === "in-sector"} disabled={filterCounts.inSector === 0} onClick={() => setReviewFilter("in-sector")}>{allSectorsSelected ? "Found in catalogue" : `Found in ${sector}`} <b>{filterCounts.inSector}</b></button>
            <button type="button" className={reviewFilter === "needs-choice" ? "bulk-filter active" : "bulk-filter"} aria-pressed={reviewFilter === "needs-choice"} disabled={filterCounts.needsChoice === 0} onClick={() => setReviewFilter("needs-choice")}>Needs a choice <b>{filterCounts.needsChoice}</b></button>
            <button type="button" className={reviewFilter === "selected" ? "bulk-filter active" : "bulk-filter"} aria-pressed={reviewFilter === "selected"} disabled={filterCounts.selected === 0} onClick={() => setReviewFilter("selected")}>URL selected <b>{filterCounts.selected}</b></button>
            <button type="button" className={reviewFilter === "skipped" ? "bulk-filter active" : "bulk-filter"} aria-pressed={reviewFilter === "skipped"} disabled={filterCounts.skipped === 0} onClick={() => setReviewFilter("skipped")}>Skipped <b>{filterCounts.skipped}</b></button>
          </div>
          {missingToGenerate.length > 0 && <div className="bulk-generate-all"><span>{missingToGenerate.length} PLUs have no catalog image. {allSectorsSelected && "Choose a destination sector for each item below. "}AI generation is billed to the OpenAI API account.</span><button type="button" className="primary-button" disabled={generatingAll || !canGenerateAll} onClick={() => void generateAllMissing()}>{generatingAll ? `Generating ${progress?.current || 1} of ${progress?.total || missingToGenerate.length}…` : `Generate all ${missingToGenerate.length} missing`}</button></div>}

          <div className="bulk-items" aria-label="PLU match review">
            {filteredItems.map(item => {
              const choice = choices[item.id];
              const busy = generatingIds.includes(item.id) || uploadingIds.includes(item.id);
              const errorText = itemErrors[item.id];
              const candidates = uniquePictures([...item.sameSector, ...item.otherSectors]);
              const selectedImage = choice?.image;
              const assigned = choice?.kind === "use";
              const showOptions = Boolean(optionsOpen[item.id]);
              const destinationReady = Boolean(destinationSector(item));
              const needsKeywordSearch = item.sameSector.length === 0;
              return <article className="bulk-item" key={item.id}>
                <div className="bulk-item-heading"><div><div className="image-meta">PLU {item.plu}</div><h3>{item.name}</h3><p>{item.rows.length} workbook row{item.rows.length === 1 ? "" : "s"}</p></div><span className={assigned ? "bulk-status assigned" : choice?.kind === "skip" ? "bulk-status skipped" : "bulk-status review"}>{busy ? uploadingIds.includes(item.id) ? bulkUploadCleanup[item.id] ? "Cleaning up" : "Uploading" : "Generating" : assigned ? "URL selected" : choice?.kind === "review" ? "Review image" : choice?.kind === "skip" ? selectedImage ? "Not assigned" : "Skipped" : candidates.length ? "Choose an image" : "No catalog match"}</span></div>
                {selectedImage ? <>
                  <div className="bulk-preview-panel">
                    <div className="bulk-preview-frame">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={selectedImage.url} alt={`Preview of ${selectedImage.name}`} />
                      {(selectedImage.generated || selectedImage.cleaned) && <span className="bulk-preview-badge">✦ {selectedImage.generated ? "AI generated" : "AI cleaned"}</span>}
                    </div>
                    <div className="bulk-preview-details">
                      <div>
                        <div className="bulk-preview-label">{selectedImage.generated ? "GENERATED IMAGE PREVIEW" : selectedImage.cleaned ? "AI CLEANUP PREVIEW" : "IMAGE PREVIEW"}</div>
                        <h4>{selectedImage.name}</h4>
                        <p>{selectedImage.sector} · PLU {selectedImage.plu}</p>
                        {normalizedPlu(selectedImage.plu) !== normalizedPlu(item.plu) && <small className="bulk-preview-note">Catalogue PLU {selectedImage.plu}; this URL will fill workbook PLU {item.plu}.</small>}
                        {selectedImage.sector !== sector && <small className="bulk-preview-note">This URL can be used in the sheet; the library item remains in {selectedImage.sector}.</small>}
                        {choice?.kind === "review" && <button type="button" className="link-button bulk-skip-match" onClick={() => changeChoice(item, { kind: "skip", image: selectedImage })}>Skip this PLU</button>}
                      </div>
                      <label className="bulk-assign-toggle">
                        <input type="checkbox" checked={Boolean(assigned)} disabled={busy} onChange={event => toggleAssignment(item, selectedImage, event.target.checked)} />
                        <span><b>Assign this URL</b><small>Fill {item.rows.length} workbook row{item.rows.length === 1 ? "" : "s"}</small></span>
                      </label>
                      {(candidates.length > 1 || item.canGenerate || needsKeywordSearch) && <button type="button" className="link-button" disabled={busy} onClick={() => setOptionsOpen(current => ({ ...current, [item.id]: !current[item.id] }))}>{showOptions ? "Hide image options" : needsKeywordSearch ? "Search catalogue or change image" : "Change image or generate another"}</button>}
                    </div>
                  </div>
                  {busy && <p className="bulk-preview-progress">{uploadingIds.includes(item.id) ? bulkUploadCleanup[item.id] ? "Cleaning up and saving the replacement. The current preview stays here until it is ready." : "Uploading the replacement. The current preview stays here until it is ready." : "Generating a replacement. The current preview stays here until it is ready."}</p>}
                  {showOptions && <div className="bulk-options-panel">
                    {(item.canGenerate || candidates.length === 0) && renderDestinationSector(item, busy)}
                    {needsKeywordSearch && renderKeywordSearch(item, busy)}
                    {candidates.length > 0 && <>
                      <p className="bulk-match-label">Choose a different catalog image for this PLU.</p>
                      <div className="bulk-candidates">
                        {candidates.map(image => <button type="button" className={`bulk-candidate${image.id === selectedImage.id ? " selected" : ""}`} key={image.publicId || image.url} disabled={busy} onClick={() => changeChoice(item, { kind: "use", image })}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={image.url} alt="" loading="lazy" />
                          <span><b>{image.name}</b><small>{image.sector} · PLU {image.plu}</small></span>
                          <span className="candidate-use">{image.id === selectedImage.id ? "Selected" : "Use URL"}</span>
                        </button>)}
                      </div>
                    </>}
                    {item.canGenerate && <>
                      <label className="form-label bulk-description-label" htmlFor={`bulk-description-${item.id}`}>AI image description <span>(starts with the item name from column B)</span></label>
                      <textarea id={`bulk-description-${item.id}`} className="field bulk-description" maxLength={1000} value={generationDescriptions[item.id] ?? item.description} disabled={Boolean(generatingAll || busy)} onChange={event => setGenerationDescriptions(current => ({ ...current, [item.id]: event.target.value }))} />
                      <div className="bulk-item-actions"><button type="button" className="bulk-generate-button" disabled={!destinationReady || Boolean(generatingAll || busy) || !(generationDescriptions[item.id] ?? item.description).trim()} onClick={() => void generateOne(item)}>{busy ? "Generating image…" : destinationReady ? `Generate new for ${destinationSector(item)}` : "Choose a sector to generate"}</button></div>
                    </>}
                    {candidates.length === 0 && renderUploadOption(item, busy)}
                  </div>}
                  {errorText && <p className="form-error" role="alert">{errorText}</p>}
                </>
                  : choice?.kind === "skip" ? <div className="bulk-selected"><span>This item will remain blank in the downloaded sheet.</span><button type="button" className="link-button" onClick={() => setChoices(current => { const next = { ...current }; delete next[item.id]; return next; })}>Review again</button></div>
                  : <>
                    {item.sameSector.length > 1 && <p className="bulk-match-label">Several images match this PLU {allSectorsSelected ? "across all sectors" : `in ${sector}`}. Choose one, generate a fresh image, or skip.</p>}
                    {item.sameSector.length === 1 && <p className="bulk-match-label">A matching image is available in {allSectorsSelected ? "the catalogue" : sector}; choose another action if needed.</p>}
                    {item.otherSectors.length > 0 && <p className="bulk-match-label">This PLU appears in another sector. Preview an existing image to use its URL in this workbook, generate a new image for {sector}, or skip.</p>}
                    {candidates.length > 0 && <div className="bulk-candidates">
                      {candidates.map(image => <button type="button" className="bulk-candidate" key={image.publicId || image.url} disabled={busy} onClick={() => changeChoice(item, { kind: "use", image })}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={image.url} alt="" loading="lazy" />
                        <span><b>{image.name}</b><small>{image.sector} · PLU {image.plu}</small></span>
                        <span className="candidate-use">Use URL</span>
                      </button>)}
                    </div>}
                    {needsKeywordSearch && renderKeywordSearch(item, busy)}
                    {(item.canGenerate || candidates.length === 0) && renderDestinationSector(item, busy)}
                    {item.canGenerate ? <>
                      <label className="form-label bulk-description-label" htmlFor={`bulk-description-${item.id}`}>AI image description <span>(starts with the item name from column B)</span></label>
                      <textarea id={`bulk-description-${item.id}`} className="field bulk-description" maxLength={1000} value={generationDescriptions[item.id] ?? item.description} disabled={Boolean(generatingAll || busy)} onChange={event => setGenerationDescriptions(current => ({ ...current, [item.id]: event.target.value }))} />
                      <div className="bulk-item-actions"><button type="button" className="bulk-generate-button" disabled={!destinationReady || Boolean(generatingAll || busy) || !(generationDescriptions[item.id] ?? item.description).trim()} onClick={() => void generateOne(item)}>{busy ? "Generating image…" : !destinationReady ? "Choose a sector to generate" : errorText ? `Retry generation for ${destinationSector(item)}` : `Generate new for ${destinationSector(item)}`}</button><button type="button" className="link-button" disabled={Boolean(generatingAll || busy)} onClick={() => changeChoice(item, { kind: "skip" })}>Skip</button></div>
                    </>
                      : <div className="bulk-item-actions"><span className="style-note">No product name is available, so AI generation is unavailable.</span><button type="button" className="link-button" disabled={Boolean(generatingAll || busy)} onClick={() => changeChoice(item, { kind: "skip" })}>Skip</button></div>}
                    {candidates.length === 0 && renderUploadOption(item, busy)}
                    {errorText && <p className="form-error" role="alert">{errorText}</p>}
                  </>}
              </article>;
            })}
          </div>
          {items.length === 0 && <div className="empty-state bulk-empty"><h3>Nothing needs filling</h3><p>Every PLU row already has an image URL, or there were no PLUs in the workbook.</p></div>}
          {items.length > 0 && filteredItems.length === 0 && <div className="empty-state bulk-empty bulk-empty-filter"><h3>No PLUs in this filter</h3><p>Try another review status to see more workbook items.</p><button type="button" className="link-button" onClick={() => setReviewFilter("all")}>Show all PLUs</button></div>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="bulk-download-summary">{rowsToFill} URL{rowsToFill === 1 ? "" : "s"} selected for {rowsToFill} row{rowsToFill === 1 ? "" : "s"}{unresolvedCount > 0 ? ` · ${unresolvedCount} item${unresolvedCount === 1 ? "" : "s"} need a choice` : " · all items reviewed"}. You can download now; PLUs without a selected URL will stay blank.</div>
          <div className="modal-actions bulk-footer-actions"><button className="secondary-button" type="button" disabled={generatingAll || Boolean(generatingIds.length) || Boolean(uploadingIds.length) || downloading} onClick={() => { setAnalysis(null); setItems([]); setChoices({}); setOptionsOpen({}); setBulkUploadFiles({}); setBulkUploadCleanup({}); setNewImageSectors({}); setItemErrors({}); setError(""); }}>Choose another file</button><button className="primary-button" type="button" disabled={items.length === 0 || downloading || generatingAll || Boolean(generatingIds.length) || Boolean(uploadingIds.length)} onClick={() => void downloadWorkbook()}>{downloading ? "Preparing workbook…" : "Assign selected URLs & download workbook ↓"}</button></div>
          <p className="style-note">Generated image requests run one at a time. Skipped rows and existing URLs are left unchanged.</p>
        </>}
      </section>
      {activeGeneration && <GenerationOverlay
        title={generatingAll ? "Generating images" : "Generating image"}
        description={generatingAll ? `Creating ${progress?.name || activeGeneration.name} in the shared photo style.` : `Creating ${activeGeneration.name} in the shared photo style.`}
        progress={generatingAll && progress ? { current: progress.current, total: progress.total } : undefined}
      />}
      {activeUpload && <GenerationOverlay
        title={bulkUploadCleanup[activeUpload.id] ? "Cleaning up image" : "Uploading image"}
        description={bulkUploadCleanup[activeUpload.id] ? `Cleaning up ${activeUpload.name} and saving it to the library.` : `Saving ${activeUpload.name} to the library.`}
      />}
    </div>
  );
}
