"use client";

import { useMemo, useState } from "react";
import { fillBulkWorkbook, inspectBulkWorkbook } from "./bulk-workbook";
import type { BulkAnalysis, BulkAssignment, BulkProduct, Picture } from "./library-types";

type ReviewProduct = BulkProduct & { sameSector: Picture[]; otherSectors: Picture[] };
type Choice = { kind: "use"; image: Picture } | { kind: "generate" } | { kind: "skip" };
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

export default function BulkUploadDialog({ apiBase, uploadPassword, sectors, onClose, onImagesAdded, notify }: Props) {
  const [sector, setSector] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<BulkAnalysis | null>(null);
  const [items, setItems] = useState<ReviewProduct[]>([]);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [generationDescriptions, setGenerationDescriptions] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [generatingAll, setGeneratingAll] = useState(false);
  const [generatingIds, setGeneratingIds] = useState<string[]>([]);
  const [progress, setProgress] = useState<{ current: number; total: number; name: string } | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});

  const choicesReady = items.length > 0 && items.every(item => {
    const choice = choices[item.id];
    return choice?.kind === "use" || choice?.kind === "skip";
  });
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
  const missingToGenerate = items.filter(item =>
    item.sameSector.length === 0 && item.otherSectors.length === 0 &&
    choices[item.id]?.kind !== "skip" && choices[item.id]?.kind !== "use" && item.canGenerate
  );

  function changeChoice(item: ReviewProduct, choice: Choice) {
    setChoices(current => ({ ...current, [item.id]: choice }));
    setItemErrors(current => { const next = { ...current }; delete next[item.id]; return next; });
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
    setLoading(true); setError(""); setAnalysis(null); setItems([]); setChoices({}); setItemErrors({});
    try {
      const workbook = await inspectBulkWorkbook(file);
      const catalog = await loadFullCatalog();
      const review = workbook.products.map(product => {
        const matches = catalog.filter(image => normalizedPlu(image.plu) === normalizedPlu(product.plu));
        const sameSector = matches.filter(image => image.sector === sector).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const otherSectors = matches.filter(image => image.sector !== sector).sort((a, b) => a.sector.localeCompare(b.sector) || b.createdAt.localeCompare(a.createdAt));
        return { ...product, sameSector, otherSectors };
      });
      const initial: Record<string, Choice> = {};
      for (const item of review) {
        if (item.sameSector.length === 1 && item.otherSectors.length === 0)
          initial[item.id] = { kind: "use", image: item.sameSector[0] };
      }
      setAnalysis(workbook); setItems(review); setChoices(initial);
      setGenerationDescriptions(Object.fromEntries(review.map(item => [item.id, item.description])));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not read this workbook.");
    } finally { setLoading(false); }
  }

  async function generateOne(item: ReviewProduct): Promise<void> {
    if (!item.canGenerate || generatingIds.includes(item.id)) return;
    setGeneratingIds(current => current.includes(item.id) ? current : [...current, item.id]);
    setChoices(current => ({ ...current, [item.id]: { kind: "generate" } }));
    setItemErrors(current => { const next = { ...current }; delete next[item.id]; return next; });
    try {
      const body = new FormData();
      body.append("mode", "generate");
      body.append("name", item.name.slice(0, 80));
      body.append("plu", item.plu);
      body.append("sector", sector);
      body.append("description", (generationDescriptions[item.id] || item.description || item.name).slice(0, 1000));
      const response = await fetch(endpoint(apiBase, "/api/images"), {
        method: "POST", headers: { "X-Upload-Password": uploadPassword }, body
      });
      const data = await response.json() as { image?: Picture; error?: string };
      if (!response.ok || !data.image) throw new Error(data.error || "Image generation failed.");
      const picture = data.image;
      setChoices(current => ({ ...current, [item.id]: { kind: "use", image: picture } }));
      onImagesAdded([picture]);
      setItemErrors(current => { const next = { ...current }; delete next[item.id]; return next; });
    } catch (cause) {
      setItemErrors(current => ({ ...current, [item.id]: cause instanceof Error ? cause.message : "Image generation failed." }));
    } finally {
      setGeneratingIds(current => current.filter(id => id !== item.id));
    }
  }

  async function generateAllMissing() {
    const targets = [...missingToGenerate];
    if (!targets.length || generatingAll) return;
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
    if (!file || !choicesReady || !rowsToFill || downloading) return;
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
    if (loading || generatingAll || generatingIds.length || downloading) return;
    onClose();
  }

  return (
    <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <section className="modal bulk-modal" role="dialog" aria-modal="true" aria-label="Fill image URLs in a bulk workbook">
        <button type="button" className="modal-close" disabled={loading || generatingAll || downloading} onClick={close} aria-label="Close dialog">×</button>
        <div className="section-eyebrow">BULK PORTAL SHEET</div>
        <h2>Fill image URLs</h2>
        <p className="modal-intro">Choose the sector first. We’ll match PLUs in column N and fill blank Image URL cells in column S. Existing URLs stay untouched, and the workbook is processed in this browser.</p>

        {!analysis ? <>
          <div className="bulk-setup-grid">
            <div>
              <label className="form-label" htmlFor="bulk-sector">Sector <b>*</b></label>
              <select id="bulk-sector" className="field" value={sector} onChange={event => setSector(event.target.value)} disabled={loading}>
                <option value="" disabled>Select a sector</option>
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
          <p className="bulk-sheet-note">Sheets checked: {analysis.sheets.join(", ")}. Existing images in <b>{sector}</b> are matched automatically when one clear match exists.</p>
          {missingToGenerate.length > 0 && <div className="bulk-generate-all"><span>{missingToGenerate.length} PLUs have no catalog image. AI generation is billed to the OpenAI API account.</span><button type="button" className="primary-button" disabled={generatingAll} onClick={() => void generateAllMissing()}>{generatingAll ? `Generating ${progress?.current || 1} of ${progress?.total || missingToGenerate.length}…` : `Generate all ${missingToGenerate.length} missing`}</button></div>}

          <div className="bulk-items" aria-label="PLU match review">
            {items.map(item => {
              const choice = choices[item.id];
              const busy = generatingIds.includes(item.id);
              const errorText = itemErrors[item.id];
              return <article className="bulk-item" key={item.id}>
                <div className="bulk-item-heading"><div><div className="image-meta">PLU {item.plu}</div><h3>{item.name}</h3><p>{item.rows.length} workbook row{item.rows.length === 1 ? "" : "s"}</p></div><span className={choice?.kind === "use" ? "bulk-status assigned" : choice?.kind === "skip" ? "bulk-status skipped" : "bulk-status review"}>{choice?.kind === "use" ? "URL assigned" : choice?.kind === "skip" ? "Skipped" : busy ? "Generating" : item.sameSector.length || item.otherSectors.length ? "Choose an image" : "No catalog match"}</span></div>
                {choice?.kind === "use" ? <div className="bulk-selected"><span>Using <b>{choice.image.name}</b> from <b>{choice.image.sector}</b></span><button type="button" className="link-button" onClick={() => { setChoices(current => { const next = { ...current }; delete next[item.id]; return next; }); }}>Change</button>{choice.image.sector !== sector && <small>The existing URL will be used in this workbook; its library sector label remains {choice.image.sector}.</small>}</div>
                  : choice?.kind === "skip" ? <div className="bulk-selected"><span>This item will remain blank in the downloaded sheet.</span><button type="button" className="link-button" onClick={() => { setChoices(current => { const next = { ...current }; delete next[item.id]; return next; }); }}>Change</button></div>
                  : <>
                    {item.sameSector.length > 1 && <p className="bulk-match-label">Several images match this PLU in {sector}. Choose one, generate a fresh image, or skip.</p>}
                    {item.sameSector.length === 1 && <p className="bulk-match-label">A matching image is available in {sector}; choose another action if needed.</p>}
                    {item.otherSectors.length > 0 && <p className="bulk-match-label">This PLU appears in another sector. Preview an existing image to use its URL in this workbook, generate a new image for {sector}, or skip.</p>}
                    {item.sameSector.length + item.otherSectors.length > 0 && <div className="bulk-candidates">
                      {uniquePictures([...item.sameSector, ...item.otherSectors]).map(image => <button type="button" className="bulk-candidate" key={image.publicId || image.url} onClick={() => changeChoice(item, { kind: "use", image })}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={image.url} alt="" loading="lazy" />
                        <span><b>{image.name}</b><small>{image.sector} · PLU {image.plu}</small></span>
                        <span className="candidate-use">Use URL</span>
                      </button>)}
                    </div>}
                    {item.canGenerate ? <>
                      <label className="form-label bulk-description-label" htmlFor={`bulk-description-${item.id}`}>AI image description <span>(starts with the item name from column B)</span></label>
                      <textarea id={`bulk-description-${item.id}`} className="field bulk-description" maxLength={1000} value={generationDescriptions[item.id] ?? item.description} disabled={Boolean(generatingAll || busy)} onChange={event => setGenerationDescriptions(current => ({ ...current, [item.id]: event.target.value }))} />
                      <div className="bulk-item-actions"><button type="button" className="bulk-generate-button" disabled={Boolean(generatingAll || busy) || !(generationDescriptions[item.id] ?? item.description).trim()} onClick={() => void generateOne(item)}>{busy ? "Generating image…" : errorText ? `Retry generation for ${sector}` : `Generate new for ${sector}`}</button><button type="button" className="link-button" disabled={Boolean(generatingAll || busy)} onClick={() => changeChoice(item, { kind: "skip" })}>Skip</button></div>
                    </>
                      : <div className="bulk-item-actions"><span className="style-note">No product name is available, so AI generation is unavailable.</span><button type="button" className="link-button" disabled={Boolean(generatingAll || busy)} onClick={() => changeChoice(item, { kind: "skip" })}>Skip</button></div>}
                    {errorText && <p className="form-error" role="alert">{errorText}</p>}
                  </>}
              </article>;
            })}
          </div>
          {items.length === 0 && <div className="empty-state bulk-empty"><h3>Nothing needs filling</h3><p>Every PLU row already has an image URL, or there were no PLUs in the workbook.</p></div>}
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="bulk-download-summary">{rowsToFill} URL{rowsToFill === 1 ? "" : "s"} ready for {rowsToFill} row{rowsToFill === 1 ? "" : "s"}{unresolvedCount > 0 ? ` · ${unresolvedCount} item${unresolvedCount === 1 ? "" : "s"} need a choice` : " · all items reviewed"}</div>
          <div className="modal-actions bulk-footer-actions"><button className="secondary-button" type="button" disabled={generatingAll || Boolean(generatingIds.length) || downloading} onClick={() => { setAnalysis(null); setItems([]); setChoices({}); setItemErrors({}); setError(""); }}>Choose another file</button><button className="primary-button" type="button" disabled={!choicesReady || rowsToFill === 0 || downloading || generatingAll || Boolean(generatingIds.length)} onClick={() => void downloadWorkbook()}>{downloading ? "Preparing workbook…" : "Download filled workbook ↓"}</button></div>
          <p className="style-note">Generated image requests run one at a time. Skipped rows and existing URLs are left unchanged.</p>
        </>}
      </section>
    </div>
  );
}
