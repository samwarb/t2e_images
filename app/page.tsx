"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import BulkUploadDialog from "./BulkUploadDialog";
import type { Picture } from "./library-types";

type ListResult = { images?: Picture[]; nextCursor?: string | null; error?: string };
type Dialog = "login" | "upload" | "bulk" | "delete" | null;
type DialogDestination = Exclude<Dialog, "login" | null>;
const sectors = ["B&I", "Chartwells", "Compass One", "Levy", "RA", "Ireland"];
const API_URL = process.env.NEXT_PUBLIC_T2E_API_URL || "";
function api(path: string): string { return API_URL.replace(/\/$/, "") + path; }

export default function Home() {
  const [images, setImages] = useState<Picture[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [afterLogin, setAfterLogin] = useState<DialogDestination>("upload");
  const [search, setSearch] = useState("");
  const [activeSector, setActiveSector] = useState("All sectors");
  const [toast, setToast] = useState("");
  const [password, setPassword] = useState("");
  // Kept in memory only, never in localStorage, repository code or query strings.
  const [uploadPassword, setUploadPassword] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [name, setName] = useState("");
  const [plu, setPlu] = useState("");
  const [sector, setSector] = useState("");
  const [creationMode, setCreationMode] = useState<"upload" | "generate">("upload");
  const [description, setDescription] = useState("");
  const [cleanup, setCleanup] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Picture | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => { void loadImages(); }, []);

  useEffect(() => {
    if (!file) { setPreview(""); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function notify(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 3500);
  }

  async function loadImages(cursor?: string) {
    if (cursor) setLoadingMore(true);
    else { setLoading(true); setLoadError(""); }
    try {
      if (!API_URL) throw new Error("The image library backend is not connected yet. Add the GitHub repository variable T2E_API_URL after deploying the Cloudflare Worker.");
      const endpoint = api("/api/images") + (cursor ? "?cursor=" + encodeURIComponent(cursor) : "");
      const response = await fetch(endpoint, { cache: "no-store" });
      const data = await response.json() as ListResult;
      if (!response.ok) throw new Error(data.error || "Unable to load images.");
      const batch = data.images || [];
      setImages(current => cursor ? [...current, ...batch.filter(p => !current.some(x => x.id === p.id))] : batch);
      setNextCursor(data.nextCursor || null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to load images.";
      setLoadError(message);
    } finally { setLoading(false); setLoadingMore(false); }
  }

  const groups = useMemo(() => {
    const counter = new Map<string, number>();
    images.forEach(image => counter.set(image.sector, (counter.get(image.sector) || 0) + 1));
    return sectors.map(value => [value, counter.get(value) || 0] as [string, number]);
  }, [images]);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return images.filter(image =>
      (activeSector === "All sectors" || image.sector === activeSector) &&
      (!term || [image.name, image.plu, image.sector, image.filename].some(value => value.toLowerCase().includes(term)))
    );
  }, [images, search, activeSector]);

  function openUpload() {
    setFormError("");
    setAfterLogin("upload");
    setDialog(authenticated ? "upload" : "login");
  }

  function openBulkUpload() {
    setFormError("");
    setAfterLogin("bulk");
    setDialog(authenticated ? "bulk" : "login");
  }

  function openDelete(image: Picture) {
    setPendingDelete(image);
    setFormError("");
    setAfterLogin("delete");
    setDialog(authenticated ? "delete" : "login");
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSigningIn(true); setFormError("");
    try {
      const response = await fetch(api("/api/auth"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password })
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error || "Unable to sign in.");
      setUploadPassword(password); setAuthenticated(true); setPassword(""); setDialog(afterLogin); notify("Upload access granted.");
    } catch (error) { setFormError(error instanceof Error ? error.message : "Sign in failed."); }
    finally { setSigningIn(false); }
  }

  function signOut() {
    setUploadPassword("");
    setAuthenticated(false);
    notify("Signed out of uploads.");
  }

  function resetForm() {
    setFile(null); setPreview(""); setName(""); setPlu(""); setSector("");
    setCreationMode("upload"); setDescription(""); setCleanup(false); setFormError("");
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creationMode === "upload" && !file) { setFormError("Select an image first."); return; }
    if (creationMode === "generate" && description.trim().length < 3) { setFormError("Describe the image you want to create."); return; }
    setUploading(true); setFormError("");
    try {
      const form = new FormData();
      if (creationMode === "upload" && file) form.append("image", file);
      form.append("name", name);
      form.append("plu", plu);
      form.append("sector", sector);
      form.append("mode", creationMode);
      if (creationMode === "generate") form.append("description", description.trim());
      form.append("cleanup", String(cleanup));
      const response = await fetch(api("/api/images"), { method: "POST", headers: { "X-Upload-Password": uploadPassword }, body: form });
      const data = await response.json() as { image?: Picture; error?: string };
      if (!response.ok || !data.image) throw new Error(data.error || "Upload failed.");
      setImages(current => [data.image as Picture, ...current]);
      setDialog(null); resetForm();
      notify("Image uploaded and ready to share.");
    } catch (error) { setFormError(error instanceof Error ? error.message : "Upload failed."); }
    finally { setUploading(false); }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true); setFormError("");
    try {
      if (!pendingDelete.publicId) throw new Error("This image needs a catalogue refresh before it can be deleted.");
      const response = await fetch(api("/api/images"), {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "X-Upload-Password": uploadPassword },
        body: JSON.stringify({ publicId: pendingDelete.publicId })
      });
      const data = await response.json() as { deleted?: boolean; error?: string };
      if (!response.ok || !data.deleted) throw new Error(data.error || "Image deletion failed.");
      setImages(current => current.filter(image => image.id !== pendingDelete.id));
      setPendingDelete(null); setDialog(null); notify("Image deleted from the library.");
    } catch (error) { setFormError(error instanceof Error ? error.message : "Image deletion failed."); }
    finally { setDeleting(false); }
  }

  async function copyLink(image: Picture) {
    try {
      await navigator.clipboard.writeText(new URL(image.url, window.location.origin).toString());
      notify("Link copied for " + image.name);
    } catch { notify("Clipboard unavailable. Open the image and copy the address."); }
  }

  const enhanced = images.filter(image => image.cleaned || image.generated).length;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">T<span>2</span>E</div>
          <div><strong>T2E Images</strong><small>Digital asset library</small></div>
        </div>
        <div className="top-actions">
          {authenticated && <button type="button" className="text-button" onClick={signOut}>Sign out</button>}
          <button type="button" className="secondary-button header-bulk" onClick={openBulkUpload}>Bulk fill sheet</button>
          <button type="button" className="primary-button header-upload" onClick={openUpload}>
            <span aria-hidden="true">＋</span> Upload image
          </button>
        </div>
      </header>

      <main className="main-content">
        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow"><span className="eyebrow-dot" /> YOUR CREATIVE WORKSPACE</div>
            <h1>Every image.<br /><em>One place.</em></h1>
            <p>Keep your food and product imagery beautifully organised. Clean up a photo or create one with AI, all in a consistent menu-ready style.</p>
            <button type="button" className="hero-button" onClick={openUpload}><span aria-hidden="true">＋</span> Add a new image <span aria-hidden="true">↗</span></button>
          </div>
          <div className="hero-art" aria-hidden="true">
            <div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" />
            <div className="art-card art-back"><div className="art-circle art-circle-one" /><div className="art-circle art-circle-two" /></div>
            <div className="art-card art-front"><div className="art-photo"><div className="art-plate"><div className="art-leaf">✳</div></div></div><div className="art-line"/><div className="art-line short"/></div>
            <div className="art-sparkle art-sparkle-one">✦</div><div className="art-sparkle art-sparkle-two">✧</div>
            <div className="art-tag">✦ AI enhanced</div>
          </div>
        </section>

        <section className="stats" aria-label="Library summary">
          <div className="stat"><span className="stat-icon lavender">▧</span><div><strong>{images.length}</strong><small>Images loaded</small></div></div>
          <div className="stat"><span className="stat-icon peach">▤</span><div><strong>{groups.length}</strong><small>Sectors</small></div></div>
          <div className="stat"><span className="stat-icon mint">✦</span><div><strong>{enhanced}</strong><small>AI enhanced</small></div></div>
        </section>

        <section className="library-section">
          <div className="section-heading">
            <div><div className="section-eyebrow">EXPLORE YOUR ASSETS</div><h2>Image library <span>({images.length})</span></h2><p>All your assets, neatly sorted and ready to share.</p></div>
            <label className="search-box"><span aria-hidden="true">⌕</span><input type="search" placeholder="Search name, PLU or sector..." aria-label="Search images" value={search} onChange={event => setSearch(event.target.value)} /></label>
          </div>
          <div className="sector-tabs" role="group" aria-label="Filter by sector">
            <button type="button" className={activeSector === "All sectors" ? "tab active" : "tab"} onClick={() => setActiveSector("All sectors")}>All sectors <span>{images.length}</span></button>
            {groups.map(([value, count]) => <button type="button" key={value} className={activeSector === value ? "tab active" : "tab"} onClick={() => setActiveSector(value)}>{value} <span>{count}</span></button>)}
          </div>

          {loadError && <div className="alert" role="alert">{loadError} <button type="button" onClick={() => void loadImages()}>Try again</button></div>}
          {loading ? <div className="loading-grid">{[1,2,3,4].map(key => <div className="skeleton" key={key}/>)}</div>
          : visible.length > 0 ? <div className="image-grid">
            {visible.map(image => <article key={image.id} className="image-card">
              <a className="image-preview" href={image.url} target="_blank" rel="noreferrer" title={"Open " + image.name}>
                {/* Remote Cloudinary URLs are served directly, so a regular img is intentional. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={image.url} alt={image.name} loading="lazy" />
                {(image.cleaned || image.generated) && <span className="ai-label">✦ {image.generated ? "AI generated" : "AI cleaned"}</span>}
              </a>
              <div className="image-info"><div className="image-meta">{image.sector}</div><h3 title={image.name}>{image.name}</h3>
                <div className="image-detail"><span>PLU <b>{image.plu}</b></span><span>{new Date(image.createdAt).toLocaleDateString("en-GB", {day:"numeric",month:"short",year:"numeric"})}</span></div>
                <div className="file-name" title={image.filename}>{image.filename}</div>
                <div className="card-actions"><button type="button" className="copy-button" onClick={() => void copyLink(image)}><span aria-hidden="true">↗</span> Copy URL Link <span className="copy-icon" aria-hidden="true">⧉</span></button><button type="button" className="delete-button" onClick={() => openDelete(image)} aria-label={`Delete ${image.name}`}>Delete</button></div>
              </div>
            </article>)}
          </div> : <div className="empty-state"><div className="empty-icon">▧</div><h3>{images.length ? "No matching images" : "Your image library starts here"}</h3><p>{images.length ? "Try another search or sector." : "Upload your first image to start building the catalogue."}</p><button type="button" className="primary-button" onClick={images.length ? () => { setSearch(""); setActiveSector("All sectors"); } : openUpload}>{images.length ? "Clear filters" : "Upload first image"}</button></div>}

          {nextCursor && <div className="load-more"><button type="button" disabled={loadingMore} onClick={() => void loadImages(nextCursor)}>{loadingMore ? "Loading images..." : "Load more images"} ↓</button></div>}
          {!loading && images.length > 0 && <p className="library-note">Sector counts and search include the images currently loaded. Use Load more for older assets.</p>}
        </section>
      </main>
      <footer><span>© T2E Image Library</span><span>Built for easy sharing with Cloudinary and Cloudflare.</span></footer>

      {toast && <div className="toast" role="status">✓ {toast}</div>}

      {dialog === "bulk" && <BulkUploadDialog apiBase={API_URL} uploadPassword={uploadPassword} sectors={sectors} onClose={() => setDialog(null)} onImagesAdded={added => setImages(current => [...added, ...current.filter(image => !added.some(next => next.id === image.id))])} notify={notify} />}
      {dialog && dialog !== "bulk" && <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !uploading && !deleting) { setDialog(null); if (dialog === "delete") setPendingDelete(null); } }}>
        <section className="modal" role="dialog" aria-modal="true" aria-label={dialog === "login" ? "Uploader sign in" : dialog === "upload" ? "Add an image" : "Delete an image"}>
          <button type="button" className="modal-close" disabled={uploading || deleting} onClick={() => { setDialog(null); if (dialog === "delete") setPendingDelete(null); }} aria-label="Close dialog">×</button>
          {dialog === "login" ? <form onSubmit={login}>
            <div className="modal-icon">◇</div><div className="section-eyebrow">SECURE ACCESS</div><h2>Uploader sign in</h2>
            <p className="modal-intro">Enter the uploader password to add images, fill a bulk sheet, or delete a library image. Your password is kept only for this tab session.</p>
            <label className="form-label" htmlFor="upload-password">Upload password</label>
            <input id="upload-password" className="field" type="password" value={password} onChange={event => setPassword(event.target.value)} autoFocus required placeholder="Enter your password" />
            {formError && <p className="form-error" role="alert">{formError}</p>}
            <button type="submit" className="primary-button full" disabled={signingIn}>{signingIn ? "Signing in..." : "Unlock uploads →"}</button>
          </form> : dialog === "upload" ? <form onSubmit={upload}>
            <div className="section-eyebrow">GROW THE LIBRARY</div><h2>Add an image</h2><p className="modal-intro">Upload a photo for AI cleanup, or create a new image from a description. Both AI options follow the same menu-photo style.</p>
            <div className="creation-modes" role="group" aria-label="Choose how to add an image">
              <button type="button" className={creationMode === "upload" ? "creation-mode active" : "creation-mode"} aria-pressed={creationMode === "upload"} onClick={() => { setCreationMode("upload"); setFormError(""); }}>Upload &amp; clean up</button>
              <button type="button" className={creationMode === "generate" ? "creation-mode active" : "creation-mode"} aria-pressed={creationMode === "generate"} onClick={() => { setCreationMode("generate"); setFormError(""); }}>Generate with AI</button>
            </div>
            {creationMode === "upload" ? <>
              <label htmlFor="image-file" className={preview ? "file-drop has-preview" : "file-drop"}>
                {preview ? <><img src={preview} alt="Selected image preview" /><span>Change image</span></> : <><span className="file-symbol">⇧</span><strong>Click to choose an image</strong><small>JPG, PNG or WebP · Max 8 MB</small></>}
              </label>
              <input id="image-file" className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" required={creationMode === "upload" && !file} onChange={event => setFile(event.target.files?.[0] || null)} />
            </> : <div className="description-field">
              <label className="form-label" htmlFor="image-description">Describe the image you want <b>*</b></label>
              <textarea id="image-description" className="field description-input" value={description} onChange={event => setDescription(event.target.value)} placeholder="e.g. Roasted vegetable and quinoa bowl with feta, chickpeas and fresh rocket" maxLength={1000} minLength={3} required={creationMode === "generate"} />
              <p className="style-note">✦ We’ll use the same warm, natural menu-photo look for every image. Low-quality AI generation is billed to your OpenAI API account.</p>
            </div>}
            <div className="form-grid">
              <div><label className="form-label" htmlFor="asset-name">Image name <b>*</b></label><input id="asset-name" className="field" value={name} onChange={event => setName(event.target.value)} placeholder="e.g. Vegan chilli" maxLength={80} required minLength={2}/></div>
              <div><label className="form-label" htmlFor="asset-plu">PLU <b>*</b></label><input id="asset-plu" className="field" value={plu} onChange={event => setPlu(event.target.value)} placeholder="e.g. 001234" maxLength={32} pattern="[a-zA-Z0-9-]+" required/></div>
              <div className="span-2"><label className="form-label" htmlFor="asset-sector">Sector <b>*</b></label><select id="asset-sector" className="field" value={sector} onChange={event => setSector(event.target.value)} required><option value="" disabled>Select a sector</option>{sectors.map(value => <option key={value} value={value}>{value}</option>)}</select></div>
            </div>
            {creationMode === "upload" && <label className="enhance-choice"><input type="checkbox" checked={cleanup} onChange={event => setCleanup(event.target.checked)} /><span className="enhance-icon">✦</span><span><strong>Clean up with AI</strong><small>Match the shared menu-photo style while preserving the food and key details. Low-quality AI editing is billed to your OpenAI API account; review edited images for accuracy.</small></span></label>}
            {name && plu && sector && <div className="filename-hint">Filename: {name.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") + "_" + plu.toLowerCase() + "_" + sector.toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") + (creationMode === "generate" || cleanup ? ".webp" : file?.type === "image/png" ? ".png" : file?.type === "image/webp" ? ".webp" : ".jpg")}</div>}
            {formError && <p className="form-error" role="alert">{formError}</p>}
            <div className="modal-actions"><button className="secondary-button" disabled={uploading} type="button" onClick={() => setDialog(null)}>Cancel</button><button className="primary-button" type="submit" disabled={uploading || (creationMode === "upload" && !file) || (creationMode === "generate" && description.trim().length < 3)}>{uploading ? (creationMode === "generate" ? "Generating and uploading..." : cleanup ? "Cleaning and uploading..." : "Uploading...") : creationMode === "generate" ? "Generate image →" : cleanup ? "Clean up & upload →" : "Upload image →"}</button></div>
          </form> : pendingDelete && <div>
            <div className="modal-icon delete-modal-icon">⌫</div><div className="section-eyebrow">REMOVE FROM LIBRARY</div><h2>Delete this image?</h2>
            <p className="modal-intro">You’re deleting <b>{pendingDelete.name}</b> (PLU {pendingDelete.plu}, {pendingDelete.sector}). The image will be permanently removed from Cloudinary. Any portal sheet using this URL will stop loading after cached copies expire.</p>
            <p className="delete-note">This cannot be undone. CDN cache invalidation can take a few seconds or minutes to finish.</p>
            {formError && <p className="form-error" role="alert">{formError}</p>}
            <div className="modal-actions"><button className="secondary-button" disabled={deleting} type="button" onClick={() => { setPendingDelete(null); setDialog(null); }}>Cancel</button><button className="danger-confirm-button" disabled={deleting} type="button" onClick={() => void confirmDelete()}>{deleting ? "Deleting image…" : "Delete image permanently"}</button></div>
          </div>}
        </section>
      </div>}
    </div>
  );
}
